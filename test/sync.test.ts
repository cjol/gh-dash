import { beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type DashboardConfig } from "../src/config";
import { migrate, type Sql } from "../src/db";
import { GitHub } from "../src/github";
import { syncAll } from "../src/sync";
import { nodeSql } from "../scripts/node-sql";
import { FakeGitHub, type FakeIssue } from "./fake-github";

const REPO = "acme/app";
const T0 = new Date("2026-10-01T12:00:00Z"); // first sync
const at = (iso: string) => new Date(iso);

function issue(n: number, over: Partial<FakeIssue> = {}): FakeIssue {
  return {
    number: n, title: `Issue ${n}`, state: "open", user: "alice", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
    closed_at: null, comments: 0, labels: [], assignees: [], ...over,
  };
}

function pr(n: number, over: Partial<FakeIssue> = {}, pr: Partial<NonNullable<FakeIssue["pr"]>> = {}): FakeIssue {
  return issue(n, { title: `PR ${n}`, ...over, pr: { merged_at: null, draft: false, head: `feat-${n}`, base: "main", reviewers: [], ...pr } });
}

describe("sync", () => {
  let gh: FakeGitHub;
  let sql: Sql;
  let cfg: DashboardConfig;
  const client = () => new GitHub({}, sql, gh.fetch);
  const run = (now: Date, configure?: (c: GitHub) => void) => {
    const c = client();
    configure?.(c);
    return syncAll(sql, c, cfg, now);
  };
  const rows = <T = Record<string, unknown>>(q: string, ...b: unknown[]) => sql.exec<T>(q, ...b);

  beforeEach(() => {
    gh = new FakeGitHub();
    sql = nodeSql();
    migrate(sql);
    cfg = parseConfig({ repos: [{ name: REPO, branches: "all" }], users: [{ login: "alice" }, { login: "bob" }] });
    const r = gh.repo(REPO);
    r.issues.push(
      issue(1), // old, open
      issue(2, { state: "closed", closed_at: "2026-09-20T00:00:00Z", updated_at: "2026-09-20T00:00:00Z" }), // closed before backfill
      issue(3, { state: "closed", closed_at: "2026-09-29T00:00:00Z", updated_at: "2026-09-29T00:00:00Z", created_at: "2026-09-28T09:00:00Z" }),
      pr(4, { created_at: "2026-09-30T00:00:00Z", updated_at: "2026-09-30T00:00:00Z", user: "bob" }, { reviewers: ["alice"] }),
    );
    r.issueComments.push(
      { id: 10, number: 1, user: "bob", created_at: "2026-09-02T00:00:00Z", updated_at: "2026-09-02T00:00:00Z", body: "old" },
      { id: 11, number: 1, user: "bob", created_at: "2026-09-29T10:00:00Z", updated_at: "2026-09-29T10:00:00Z", body: "recent" },
    );
    r.reviewComments.push({ id: 20, number: 4, user: "alice", created_at: "2026-09-30T10:00:00Z", updated_at: "2026-09-30T10:00:00Z", body: "nit", path: "src/a.ts" });
    gh.commit(REPO, "main", { sha: "c1", date: "2026-09-01T00:00:00Z", files: [{ filename: "README.md", additions: 1, deletions: 0 }] });
    gh.commit(REPO, "main", { sha: "c2", date: "2026-09-29T00:00:00Z", files: [{ filename: "src/a.ts", additions: 10, deletions: 2 }] });
    gh.commit(REPO, "feat-4", { sha: "f1", date: "2026-09-30T00:00:00Z", login: "bob", files: [{ filename: "src/b/c.ts", additions: 5, deletions: 5 }] }, "main");
  });

  it("initial sync without backfill: open items only, history starts now", async () => {
    const report = await run(T0);
    expect(report.incomplete).toBe(false);
    expect(rows(`SELECT number FROM items ORDER BY number`).map((r) => r.number)).toEqual([1, 4]);
    expect(rows(`SELECT * FROM commits`)).toEqual([]);
    expect(rows(`SELECT * FROM comments`)).toEqual([]);
    const pr4 = rows<{ requested_reviewers: string; head_ref: string }>(`SELECT * FROM items WHERE number = 4`)[0];
    expect(JSON.parse(pr4.requested_reviewers)).toEqual(["alice"]);
    expect(pr4.head_ref).toBe("feat-4");
    // Branch heads are recorded so the next poll only walks what moved.
    expect(rows(`SELECT name FROM branches ORDER BY name`).map((b) => b.name)).toEqual(["feat-4", "main"]);
  });

  describe("with backfill", () => {
    beforeEach(() => {
      cfg = { ...cfg, backfillSince: "2026-09-28T00:00:00Z" };
    });

    it("pulls closed items, commits with file stats and new comments since the backfill date", async () => {
      await run(T0);
      expect(rows(`SELECT number FROM items ORDER BY number`).map((r) => r.number)).toEqual([1, 3, 4]);
      expect(rows(`SELECT event, number FROM item_events`)).toEqual([{ event: "closed", number: 3 }]);
      expect(rows(`SELECT sha, branch, files_status, additions, deletions FROM commits ORDER BY sha`)).toEqual([
        { sha: "c2", branch: "main", files_status: "done", additions: 10, deletions: 2 },
        { sha: "f1", branch: "feat-4", files_status: "done", additions: 5, deletions: 5 },
      ]);
      expect(rows(`SELECT path FROM commit_files ORDER BY path`).map((r) => r.path)).toEqual(["src/a.ts", "src/b/c.ts"]);
      expect(rows(`SELECT kind, id FROM comments ORDER BY id`)).toEqual([{ kind: "issue", id: 11 }, { kind: "review", id: 20 }]);
    });

    it("a quiet poll is all 304s", async () => {
      await run(T0);
      // The poll after a cursor moves asks for a new since= URL, so it costs one 200 per moved cursor.
      await run(at("2026-10-01T12:10:00Z"));
      gh.calls = [];
      const report = await run(at("2026-10-01T12:20:00Z"));
      expect(gh.calls.length).toBeGreaterThan(0);
      expect(gh.calls.every((c) => c.status === 304)).toBe(true);
      expect(report.notModified).toBe(gh.calls.length);
      expect(report.repos[0].unchanged.sort()).toEqual(["branches", "issue-comments", "issues", "pulls", "review-comments"]);
    });

    it("tracks closes, reopens, merges, new comments and pushes", async () => {
      await run(T0);
      const r = gh.repo(REPO);
      const t = "2026-10-01T13:00:00Z";
      Object.assign(r.issues[0], { state: "closed", closed_at: t, updated_at: t });
      Object.assign(r.issues[2], { state: "open", closed_at: null, updated_at: t });
      Object.assign(r.issues[3], { state: "closed", closed_at: t, updated_at: t });
      r.issues[3].pr!.merged_at = t;
      r.issues.push(issue(5, { created_at: t, updated_at: t, user: "bob" }));
      // An edit to a pre-backfill comment must not pull it into the mirror.
      Object.assign(r.issueComments[0], { updated_at: t, body: "edited" });
      r.issueComments.push({ id: 12, number: 5, user: "alice", created_at: t, updated_at: t, body: "on it" });
      gh.commit(REPO, "main", { sha: "c3", date: t, files: [{ filename: "src/a.ts", additions: 1, deletions: 1 }] });
      // A merge commit and a new branch made from main: neither should duplicate or expand history.
      gh.commit(REPO, "main", { sha: "m1", date: "2026-10-01T13:05:00Z" });
      r.commits.m1.parents = ["c3", "f1"];
      r.branches["release"] = "c3";

      gh.calls = [];
      await run(at("2026-10-01T13:10:00Z"));
      const state = (n: number) => rows<{ state: string; merged_at: string | null }>(`SELECT state, merged_at FROM items WHERE number = ?`, n)[0];
      expect(state(1).state).toBe("closed");
      expect(state(3).state).toBe("open");
      expect(state(4)).toEqual({ state: "closed", merged_at: t });
      expect(state(5).state).toBe("open");
      expect(rows(`SELECT event, number FROM item_events ORDER BY number, event`)).toEqual([
        { event: "closed", number: 1 }, { event: "closed", number: 3 }, { event: "reopened", number: 3 },
        { event: "closed", number: 4 }, { event: "merged", number: 4 },
      ]);
      expect(rows(`SELECT id FROM comments WHERE kind = 'issue' ORDER BY id`).map((c) => c.id)).toEqual([11, 12]);
      expect(rows(`SELECT sha, files_status FROM commits WHERE sha IN ('c3', 'm1') ORDER BY sha`)).toEqual([
        { sha: "c3", files_status: "done" }, { sha: "m1", files_status: "merge" },
      ]);
      // Only the new non-merge commit needed a detail call.
      expect(gh.calls.filter((c) => /\/commits\/\w+$/.test(c.url.split("?")[0])).map((c) => c.url)).toEqual([`/repos/${REPO}/commits/c3`]);
      expect(rows(`SELECT count(*) AS n FROM commits`)[0].n).toBe(4);
    });

    it("resumes after hitting the per-run request cap without losing work", async () => {
      const report = await run(T0, (c) => (c.maxRequests = 6));
      expect(report.incomplete).toBe(true);
      let guard = 0;
      let last;
      do {
        last = await run(at("2026-10-01T12:01:00Z"), (c) => (c.maxRequests = 6));
      } while (last.incomplete && ++guard < 20);
      expect(last.incomplete).toBe(false);
      expect(rows(`SELECT number FROM items ORDER BY number`).map((r) => r.number)).toEqual([1, 3, 4]);
      expect(rows(`SELECT sha, files_status FROM commits ORDER BY sha`)).toEqual([
        { sha: "c2", files_status: "done" }, { sha: "f1", files_status: "done" },
      ]);
      expect(rows(`SELECT count(*) AS n FROM comments`)[0].n).toBe(2);
    });
  });

  it("follows pagination and only keeps ETags for single-page listings", async () => {
    const r = gh.repo(REPO);
    for (let n = 100; n < 350; n++) r.issues.push(issue(n, { created_at: "2026-09-10T00:00:00Z" }));
    await run(T0);
    expect(rows(`SELECT count(*) AS n FROM items WHERE state = 'open'`)[0].n).toBe(252);
    expect(gh.calls.filter((c) => c.url.includes("/issues?state=open")).length).toBe(3);
    // The open-PR listing is one page, so its ETag is kept; nothing multi-page is.
    const cached = rows<{ url: string }>(`SELECT url FROM http_cache`).map((c) => c.url);
    expect(cached.some((u) => u.includes("/pulls?state=open"))).toBe(true);
    expect(cached.some((u) => u.includes("/issues?state=open"))).toBe(false);
  });

  it("records rate-limit state and stops before the reserve", async () => {
    gh.rateRemaining = 52; // reserve for authenticated clients is 50
    const c = new GitHub({ GITHUB_TOKEN: "x" }, sql, gh.fetch);
    const report = await syncAll(sql, c, cfg, T0);
    expect(report.incomplete).toBe(true);
    expect(report.rateRemaining).toBe(50);
    expect(rows<{ last_error: string }>(`SELECT last_error FROM repo_state`)[0].last_error).toMatch(/rate budget/);
  });
});

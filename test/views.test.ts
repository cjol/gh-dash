import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";
import { migrate } from "../src/db";
import { appJwt, GitHub, parseNextLink } from "../src/github";
import { syncAll } from "../src/sync";
import { localDate, localDayRange } from "../src/time";
import { activityOverview, churn, commitPerson, dirOf, globToRegExp, openPrs, personDay, repoHealth } from "../src/views";
import { nodeSql } from "../scripts/node-sql";
import { FakeGitHub } from "./fake-github";

describe("time", () => {
  it("maps local days to UTC ranges across DST", () => {
    expect(localDayRange("2026-10-05", "Europe/London")).toEqual(["2026-10-04T23:00:00Z", "2026-10-05T23:00:00Z"]);
    // Clocks go back on 25 Oct 2026: a 25-hour day.
    expect(localDayRange("2026-10-25", "Europe/London")).toEqual(["2026-10-24T23:00:00Z", "2026-10-26T00:00:00Z"]);
    expect(localDayRange("2026-10-05", "UTC")).toEqual(["2026-10-05T00:00:00Z", "2026-10-06T00:00:00Z"]);
    expect(localDate("2026-10-04T23:30:00Z", "Europe/London")).toBe("2026-10-05");
  });
});

describe("helpers", () => {
  it("dirOf truncates to depth", () => {
    expect(dirOf("README.md", 2)).toBe("(root)");
    expect(dirOf("src/a.ts", 2)).toBe("src/");
    expect(dirOf("src/b/c/d.ts", 2)).toBe("src/b/");
  });

  it("globs match basenames or full paths", () => {
    expect(globToRegExp("package-lock.json").test("web/package-lock.json")).toBe(true);
    expect(globToRegExp("*.snap").test("src/__snapshots__/x.test.ts.snap")).toBe(true);
    expect(globToRegExp("dist/**").test("dist/a/b.js")).toBe(true);
    expect(globToRegExp("dist/**").test("src/dist/a.js")).toBe(false);
  });

  it("maps commits to people by login, then aliases", () => {
    const users = [{ login: "Alice", aliases: ["alice@home.example"] }];
    expect(commitPerson({ author_login: "alice", author_email: null, author_name: null }, users)).toBe("Alice");
    expect(commitPerson({ author_login: null, author_email: "ALICE@home.example", author_name: "A" }, users)).toBe("Alice");
    expect(commitPerson({ author_login: "mallory", author_email: "alice@home.example", author_name: null }, users)).toBe(null);
  });

  it("parses Link headers", () => {
    expect(parseNextLink('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"')).toBe("https://api.github.com/x?page=2");
    expect(parseNextLink(null)).toBeUndefined();
  });
});

describe("GitHub App auth", () => {
  it("signs an RS256 JWT from a PKCS#1 key", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const jwt = await appJwt("12345", pem, Date.parse("2026-10-05T00:00:00Z"));
    const [h, p, sig] = jwt.split(".");
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toMatchObject({ iss: "12345", iat: 1791158340, exp: 1791158880 });
    const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, "base64url"));
    expect(ok).toBe(true);
  });

  it("exchanges the JWT for an installation token and uses it", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const seen: { url: string; auth: string | null }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/orgs/acme/installation")) return Response.json({ id: 99 });
      if (url.endsWith("/app/installations/99/access_tokens")) return Response.json({ token: "ghs_abc", expires_at: "2099-01-01T00:00:00Z" });
      return Response.json([], { headers: { "x-ratelimit-remaining": "4999" } });
    }) as typeof fetch;
    const sql = nodeSql();
    migrate(sql);
    const gh = new GitHub({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }).toString() }, sql, fetchImpl);
    expect(gh.authMode).toBe("app");
    await gh.get("/repos/acme/app/issues", { owner: "acme" });
    await gh.get("/repos/acme/app/pulls", { owner: "acme" });
    expect(seen.map((s) => s.url.replace("https://api.github.com", ""))).toEqual([
      "/orgs/acme/installation", "/app/installations/99/access_tokens", "/repos/acme/app/issues", "/repos/acme/app/pulls",
    ]);
    expect(seen[0].auth).toMatch(/^Bearer ey/);
    expect(seen[2].auth).toBe("token ghs_abc");
    expect(seen[3].auth).toBe("token ghs_abc"); // cached
  });
});

describe("views", () => {
  async function seeded() {
    const gh = new FakeGitHub();
    const repo = gh.repo("acme/app");
    const t = (d: string) => `2026-10-0${d}`;
    repo.issues.push(
      { number: 1, title: "Old bug", state: "open", user: "carol", created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z", closed_at: null, comments: 0, labels: [], assignees: [] },
      { number: 2, title: "Discussed", state: "open", user: "carol", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", closed_at: null, comments: 3, labels: ["bug"], assignees: ["alice"] },
      { number: 3, title: "Fixed", state: "closed", user: "alice", created_at: t("2T09:00:00Z"), updated_at: t("3T10:00:00Z"), closed_at: t("3T10:00:00Z"), comments: 1, labels: [], assignees: [] },
      { number: 4, title: "Feature", state: "open", user: "alice", created_at: t("3T08:00:00Z"), updated_at: t("3T08:00:00Z"), closed_at: null, comments: 0, labels: [], assignees: [], pr: { merged_at: null, draft: true, head: "f", base: "main", reviewers: ["bob"] } },
    );
    repo.issueComments.push({ id: 1, number: 3, user: "alice", created_at: t("3T09:00:00Z"), updated_at: t("3T09:00:00Z"), body: "Looking into this" });
    repo.reviewComments.push({ id: 2, number: 4, user: "bob", created_at: t("3T11:00:00Z"), updated_at: t("3T11:00:00Z"), body: "Rename?", path: "src/x.ts" });
    gh.commit("acme/app", "main", { sha: "a1", date: t("3T08:30:00Z"), files: [{ filename: "src/x.ts", additions: 30, deletions: 3 }, { filename: "package-lock.json", additions: 900, deletions: 800 }] });
    gh.commit("acme/app", "main", { sha: "a2", date: t("3T12:00:00Z"), login: null, name: "Bob B", email: "bob@laptop", files: [{ filename: "docs/guide/intro.md", additions: 12, deletions: 0 }] });

    const cfg = parseConfig({
      timezone: "Europe/London", backfillSince: "2026-10-01T00:00:00Z",
      repos: ["acme/app"], users: [{ login: "alice", name: "Alice" }, { login: "bob", aliases: ["bob@laptop"] }],
      churnExclude: ["package-lock.json"],
    });
    const sql = nodeSql();
    migrate(sql);
    await syncAll(sql, new GitHub({}, sql, gh.fetch), cfg, new Date("2026-10-04T12:00:00Z"));
    return { sql, cfg };
  }

  it("activity overview counts per person per local day", async () => {
    const { sql, cfg } = await seeded();
    const v = activityOverview(sql, cfg, "2026-10-04", 3);
    expect(v.dates).toEqual(["2026-10-02", "2026-10-03", "2026-10-04"]);
    const day = (login: string, d: string) => v.people.find((p) => p.login === login)!.days.find((x) => x.date === d);
    expect(day("alice", "2026-10-02")).toMatchObject({ opened: 1 });
    expect(day("alice", "2026-10-03")).toMatchObject({ commits: 1, opened: 1, comments: 1 });
    expect(day("bob", "2026-10-03")).toMatchObject({ commits: 1, reviewComments: 1 }); // commit matched by email alias
  });

  it("person-day detail lists commits, items and conversations", async () => {
    const { sql, cfg } = await seeded();
    const d = personDay(sql, cfg, "alice", "2026-10-03");
    expect(d.commits.map((c) => c.sha)).toEqual(["a1"]);
    expect(d.commits[0].topDirs[0]).toEqual({ dir: "(root)", lines: 1700 });
    expect(d.opened.map((i) => i.number)).toEqual([4]);
    expect(d.closed.map((i) => i.number)).toEqual([3]);
    expect(d.threads).toMatchObject([{ number: 3, title: "Fixed", comments: [{ excerpt: "Looking into this" }] }]);
  });

  it("repo health raw numbers", async () => {
    const { sql, cfg } = await seeded();
    const [h] = repoHealth(sql, cfg, new Date("2026-10-04T12:00:00Z"));
    expect(h).toMatchObject({ openIssues: 2, openPrs: 1, draftPrs: 1, openIssuesNoComments: 1, unassignedOpenIssues: 1, unlabelledOpenIssues: 1 });
    expect(h.oldestNoComment?.number).toBe(1);
    expect(h.windows[0]).toMatchObject({ days: 7, issuesOpened: 1, issuesClosed: 1, complete: false });
    expect(h.weeks.at(-1)).toMatchObject({ week: "2026-09-28", opened: 1, closed: 1 });
  });

  it("open PRs with ages", async () => {
    const { sql, cfg } = await seeded();
    const v = openPrs(sql, cfg, new Date("2026-10-04T08:00:00Z"));
    expect(v.prs).toHaveLength(1);
    expect(v.prs[0]).toMatchObject({ number: 4, draft: true, team: true, requestedReviewers: ["bob"], reviewComments: 1 });
    expect(v.prs[0].ageDays).toBeCloseTo(1, 5);
  });

  it("churn by directory with exclusions and people filter", async () => {
    const { sql, cfg } = await seeded();
    const all = churn(sql, cfg, { from: "2026-10-01", to: "2026-10-04", depth: 2, exclude: true });
    expect(all.dirs.map((d) => [d.dir, d.additions, d.deletions])).toEqual([["src/", 30, 3], ["docs/guide/", 12, 0]]);
    expect(all.totals).toMatchObject({ commits: 2, excludedLines: 1700, pendingCommits: 0 });
    const unfiltered = churn(sql, cfg, { from: "2026-10-01", to: "2026-10-04", depth: 1, exclude: false });
    expect(unfiltered.dirs[0]).toMatchObject({ dir: "(root)", lines: 1700 });
    const bob = churn(sql, cfg, { from: "2026-10-01", to: "2026-10-04", depth: 1, exclude: true, who: "bob" });
    expect(bob.dirs.map((d) => d.dir)).toEqual(["docs/"]);
  });
});

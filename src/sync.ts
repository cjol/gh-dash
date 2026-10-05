import type { DashboardConfig, RepoConfig } from "./config";
import { getMeta, setMeta, type Sql } from "./db";
import { GitHub, RateLimitedError, RequestBudgetError } from "./github";
import { toIso } from "./time";

/**
 * Mirrors GitHub into SQLite. Every stage is incremental and resumable: cursors only advance after a
 * stage finishes, so a run cut short (rate limit, per-run request cap) is picked up by the next one.
 *
 * Per repo, per run (steady state, nothing changed → all 304s, which don't count against the rate limit):
 *   issues+PRs listing (since cursor) · open PR listing · issue comments (since) · review comments
 *   (since) · branch heads. Then, only for what changed: commit listings for moved branches, and one
 *   commit-detail call per new non-merge commit for its per-file line counts.
 */

export interface RepoReport {
  repo: string;
  items: number;
  comments: number;
  commits: number;
  commitFiles: number;
  unchanged: string[];
  error?: string;
}

export interface SyncReport {
  startedAt: string;
  finishedAt: string;
  requests: number;
  notModified: number;
  rateRemaining?: number;
  rateLimit?: number;
  rateReset?: string;
  /** True when a run stopped early and more work is waiting. */
  incomplete: boolean;
  repos: RepoReport[];
}

interface RepoState {
  repo: string;
  floor: string;
  initial_done: number;
  default_branch: string | null;
  issues_cursor: string | null;
  issue_comments_cursor: string | null;
  review_comments_cursor: string | null;
}

// --- GitHub payload shapes (only the fields we use) ---
interface GhUser { login: string }
interface GhIssue {
  number: number; title: string; state: string; state_reason?: string | null; draft?: boolean;
  user: GhUser | null; author_association?: string; assignees?: GhUser[] | null; labels?: ({ name: string } | string)[];
  comments: number; created_at: string; updated_at: string; closed_at: string | null; html_url: string;
  pull_request?: { merged_at?: string | null };
}
interface GhPull {
  number: number; draft?: boolean; head: { ref: string }; base: { ref: string };
  requested_reviewers?: GhUser[]; requested_teams?: { slug: string }[];
}
interface GhComment {
  id: number; user: GhUser | null; author_association?: string; created_at: string; updated_at: string;
  body?: string; html_url: string; issue_url?: string; pull_request_url?: string; path?: string;
}
interface GhBranch { name: string; commit: { sha: string } }
interface GhCommit {
  sha: string; html_url: string; parents: { sha: string }[];
  author: GhUser | null; committer: GhUser | null;
  commit: { message: string; author: { name: string; email: string; date: string }; committer: { date: string } };
  stats?: { additions: number; deletions: number };
  files?: { filename: string; status: string; additions: number; deletions: number; previous_filename?: string }[];
}

const MAX_BODY = 4000;

/** syncAll, recorded in sync_log (what the Sync tab shows). */
export async function runLoggedSync(sql: Sql, gh: GitHub, config: DashboardConfig, trigger: string): Promise<SyncReport> {
  const id = sql.exec<{ id: number }>(`INSERT INTO sync_log (trigger, started_at) VALUES (?, ?) RETURNING id`, trigger, toIso(new Date()))[0].id;
  try {
    const report = await syncAll(sql, gh, config);
    sql.exec(
      `UPDATE sync_log SET finished_at = ?, requests = ?, not_modified = ?, rate_remaining = ?, summary = ? WHERE id = ?`,
      report.finishedAt, report.requests, report.notModified, report.rateRemaining ?? null, JSON.stringify(report), id,
    );
    return report;
  } catch (e) {
    sql.exec(`UPDATE sync_log SET finished_at = ?, requests = ?, error = ? WHERE id = ?`, toIso(new Date()), gh.requests, String(e), id);
    throw e;
  } finally {
    sql.exec(`DELETE FROM sync_log WHERE id < ?`, id - 500);
  }
}

type Stage = "issues" | "pulls" | "issue-comments" | "review-comments" | "commits";
const STAGES: Stage[] = ["issues", "pulls", "issue-comments", "review-comments", "commits"];

export async function syncAll(sql: Sql, gh: GitHub, config: DashboardConfig, now = new Date()): Promise<SyncReport> {
  const startedAt = toIso(now);
  const reports = new Map<string, RepoReport>();
  for (const repo of config.repos) {
    reports.set(repo.name, { repo: repo.name, items: 0, comments: 0, commits: 0, commitFiles: 0, unchanged: [] });
    ensureRepoState(sql, repo.name, config, now);
  }

  // Work is a ring of (repo, stage) tasks. A run cut short records where it stopped and the next run
  // starts there, so a tight per-run budget still makes progress instead of redoing the first stages.
  const tasks = config.repos.flatMap((repo) => STAGES.map((stage) => ({ repo, stage })));
  const start = Number(getMeta(sql, "resume_task") ?? 0) % tasks.length || 0;
  const failed = new Set<string>();
  const completed = new Set<string>();
  let incomplete = false;

  for (let k = 0; k < tasks.length; k++) {
    const i = (start + k) % tasks.length;
    const { repo, stage } = tasks[i];
    if (failed.has(repo.name)) continue;
    const report = reports.get(repo.name)!;
    sql.exec(`UPDATE repo_state SET last_sync_at = ? WHERE repo = ?`, startedAt, repo.name);
    try {
      await runStage(sql, gh, repo, stage, report, now);
      if (stage === STAGES.at(-1)) completed.add(repo.name);
    } catch (e) {
      if (isBudget(e)) {
        incomplete = true;
        setMeta(sql, "resume_task", String(i));
        // Running out of per-run budget is routine; an actual rate limit is worth surfacing.
        if (e instanceof RateLimitedError) recordError(sql, repo.name, report, e);
        break;
      }
      failed.add(repo.name);
      recordError(sql, repo.name, report, e);
    }
  }
  if (!incomplete) setMeta(sql, "resume_task", "0");

  // Commit details are the expensive part (one call per commit), so they go last and share whatever
  // budget is left, round-robin across repos so one busy repo can't starve the others.
  if (!incomplete) {
    try {
      incomplete = await fetchCommitFiles(sql, gh, config, [...reports.values()]);
    } catch (e) {
      if (!isBudget(e)) throw e;
      incomplete = true;
    }
  }

  const finishedAt = toIso(new Date());
  for (const r of reports.values()) {
    // A repo counts as synced once all its stages ran (in this run, or finishing a resumed one).
    if (!r.error && (completed.has(r.repo) || !incomplete)) {
      sql.exec(`UPDATE repo_state SET last_success_at = ?, last_error = NULL WHERE repo = ?`, finishedAt, r.repo);
    }
  }
  return {
    startedAt, finishedAt, requests: gh.requests, notModified: gh.notModified,
    rateRemaining: gh.rateRemaining, rateLimit: gh.rateLimit, rateReset: gh.rateReset,
    incomplete, repos: [...reports.values()],
  };
}

function isBudget(e: unknown): boolean {
  return e instanceof RateLimitedError || e instanceof RequestBudgetError;
}

function recordError(sql: Sql, repo: string, report: RepoReport, e: unknown): void {
  report.error = e instanceof Error ? e.message : String(e);
  sql.exec(`UPDATE repo_state SET last_error = ? WHERE repo = ?`, report.error, repo);
}

export function ensureRepoState(sql: Sql, repo: string, config: DashboardConfig, now: Date): RepoState {
  const existing = sql.exec<RepoState>(`SELECT * FROM repo_state WHERE repo = ?`, repo)[0];
  if (existing) return existing;
  const floor = config.backfillSince && config.backfillSince < toIso(now) ? config.backfillSince : toIso(now);
  sql.exec(`INSERT INTO repo_state (repo, floor) VALUES (?, ?)`, repo, floor);
  return sql.exec<RepoState>(`SELECT * FROM repo_state WHERE repo = ?`, repo)[0];
}

async function runStage(sql: Sql, gh: GitHub, repo: RepoConfig, stage: Stage, report: RepoReport, now: Date): Promise<void> {
  const [owner] = repo.name.split("/");
  const state = sql.exec<RepoState>(`SELECT * FROM repo_state WHERE repo = ?`, repo.name)[0];
  const base = `/repos/${repo.name}`;

  switch (stage) {
    case "issues":
      return syncIssues(sql, gh, owner, repo.name, state, report, now);
    case "pulls": {
      // Open PR details the issues listing lacks: branches and requested reviewers.
      const path = `${base}/pulls?state=open&per_page=100`;
      const pulls = await gh.paginate<GhPull>(path, { owner, conditional: true, deferEtag: true });
      if (!pulls.changed) {
        report.unchanged.push("pulls");
        return;
      }
      let allKnown = true;
      for (const pr of pulls.items) {
        const reviewers = [...(pr.requested_reviewers ?? []).map((u) => u.login), ...(pr.requested_teams ?? []).map((t) => `team:${t.slug}`)];
        const updated = sql.exec(
          `UPDATE items SET head_ref = ?, base_ref = ?, requested_reviewers = ?, draft = ? WHERE repo = ? AND number = ? RETURNING number`,
          pr.head.ref, pr.base.ref, JSON.stringify(reviewers), pr.draft ? 1 : 0, repo.name, pr.number,
        );
        allKnown &&= updated.length > 0;
      }
      // A PR the issues stage hasn't mirrored yet: don't cache, so the next poll applies it.
      if (allKnown) gh.storeEtag(path, pulls.etag);
      return;
    }
    case "issue-comments":
      // Comments: only ones created since the floor ("new only").
      report.comments += await syncComments(sql, gh, owner, repo.name, "issue", `${base}/issues/comments`, state.issue_comments_cursor ?? state.floor, state.floor, report);
      return;
    case "review-comments":
      report.comments += await syncComments(sql, gh, owner, repo.name, "review", `${base}/pulls/comments`, state.review_comments_cursor ?? state.floor, state.floor, report);
      return;
    case "commits":
      if (!state.default_branch) {
        const res = await gh.get<{ default_branch: string }>(base, { owner });
        state.default_branch = res!.data.default_branch;
        sql.exec(`UPDATE repo_state SET default_branch = ? WHERE repo = ?`, state.default_branch, repo.name);
      }
      report.commits += await syncCommits(sql, gh, owner, repo, state, report, now);
      return;
  }
}

/** Issues + PRs. The issues listing returns both, including merged_at for PRs. */
async function syncIssues(sql: Sql, gh: GitHub, owner: string, repo: string, state: RepoState, report: RepoReport, now: Date): Promise<void> {
  const base = `/repos/${repo}`;
  if (!state.initial_done) {
    // Everything currently open, however old...
    const open = await gh.paginate<GhIssue>(`${base}/issues?state=open&per_page=100`, { owner });
    // ...plus anything (including closed) touched since the floor, when backfilling.
    let cursor = toIso(now);
    let recent: GhIssue[] = [];
    if (state.floor < toIso(now)) {
      recent = (await gh.paginate<GhIssue>(`${base}/issues?state=all&sort=updated&direction=asc&per_page=100&since=${state.floor}`, { owner })).items;
      cursor = maxIso(state.floor, ...recent.map((i) => i.updated_at));
    }
    for (const issue of [...open.items, ...recent]) if (upsertItem(sql, repo, issue, now)) report.items++;
    sql.exec(`UPDATE repo_state SET issues_cursor = ?, initial_done = 1 WHERE repo = ?`, cursor, repo);
    return;
  }
  const res = await gh.paginate<GhIssue>(`${base}/issues?state=all&sort=updated&direction=asc&per_page=100&since=${state.issues_cursor}`, { owner, conditional: true });
  if (!res.changed) report.unchanged.push("issues");
  for (const issue of res.items) if (upsertItem(sql, repo, issue, now)) report.items++;
  sql.exec(`UPDATE repo_state SET issues_cursor = ? WHERE repo = ?`, maxIso(state.issues_cursor!, ...res.items.map((i) => i.updated_at)), repo);
}

/** Returns false when the mirror already had this exact version (e.g. the cursor's boundary item). */
export function upsertItem(sql: Sql, repo: string, i: GhIssue, now: Date): boolean {
  const kind = i.pull_request ? "pr" : "issue";
  const mergedAt = i.pull_request?.merged_at ?? null;
  const observed = toIso(now);
  const prev = sql.exec<{ state: string; closed_at: string | null; merged_at: string | null; updated_at: string }>(
    `SELECT state, closed_at, merged_at, updated_at FROM items WHERE repo = ? AND number = ?`, repo, i.number,
  )[0];
  if (prev?.updated_at === i.updated_at) return false;
  const event = (name: string, at: string) =>
    sql.exec(`INSERT OR IGNORE INTO item_events (repo, number, event, at, observed_at) VALUES (?, ?, ?, ?, ?)`, repo, i.number, name, at, observed);

  if (prev?.state === "closed" && i.state === "open") event("reopened", i.updated_at);
  if (i.state === "closed" && i.closed_at && i.closed_at !== prev?.closed_at) event("closed", i.closed_at);
  if (mergedAt && mergedAt !== prev?.merged_at) event("merged", mergedAt);

  const labels = (i.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
  sql.exec(
    `INSERT INTO items (repo, number, kind, title, state, state_reason, draft, author, author_association, assignees, labels,
       comments, created_at, updated_at, closed_at, merged_at, html_url, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (repo, number) DO UPDATE SET
       kind = excluded.kind, title = excluded.title, state = excluded.state, state_reason = excluded.state_reason,
       draft = excluded.draft, author = excluded.author, author_association = excluded.author_association,
       assignees = excluded.assignees, labels = excluded.labels, comments = excluded.comments,
       updated_at = excluded.updated_at, closed_at = excluded.closed_at, merged_at = excluded.merged_at,
       html_url = excluded.html_url,
       requested_reviewers = CASE WHEN excluded.state = 'open' THEN items.requested_reviewers ELSE NULL END`,
    repo, i.number, kind, i.title, i.state, i.state_reason ?? null, i.draft ? 1 : 0, i.user?.login ?? null,
    i.author_association ?? null, JSON.stringify((i.assignees ?? []).map((a) => a.login)), JSON.stringify(labels),
    i.comments, i.created_at, i.updated_at, i.closed_at, mergedAt, i.html_url, observed,
  );
  return true;
}

async function syncComments(
  sql: Sql, gh: GitHub, owner: string, repo: string, kind: "issue" | "review",
  path: string, cursor: string, floor: string, report: RepoReport,
): Promise<number> {
  const res = await gh.paginate<GhComment>(`${path}?sort=updated&direction=asc&per_page=100&since=${cursor}`, { owner, conditional: true });
  if (!res.changed) report.unchanged.push(`${kind}-comments`);
  let stored = 0;
  for (const c of res.items) {
    // Edits bring old comments back into the listing; the mirror only keeps comments made since the floor.
    if (c.created_at < floor) continue;
    const known = sql.exec<{ updated_at: string }>(`SELECT updated_at FROM comments WHERE kind = ? AND id = ?`, kind, c.id)[0];
    if (known?.updated_at === c.updated_at) continue;
    const parent = kind === "issue" ? c.issue_url : c.pull_request_url;
    const number = Number(parent?.split("/").pop());
    sql.exec(
      `INSERT INTO comments (kind, id, repo, number, author, author_association, created_at, updated_at, body, path, html_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (kind, id) DO UPDATE SET updated_at = excluded.updated_at, body = excluded.body`,
      kind, c.id, repo, number, c.user?.login ?? null, c.author_association ?? null, c.created_at, c.updated_at,
      (c.body ?? "").slice(0, MAX_BODY), c.path ?? null, c.html_url,
    );
    stored++;
  }
  const next = maxIso(cursor, ...res.items.map((c) => c.updated_at));
  sql.exec(`UPDATE repo_state SET ${kind === "issue" ? "issue_comments_cursor" : "review_comments_cursor"} = ? WHERE repo = ?`, next, repo);
  return stored;
}

async function syncCommits(sql: Sql, gh: GitHub, owner: string, repo: RepoConfig, state: RepoState, report: RepoReport, now: Date): Promise<number> {
  const base = `/repos/${repo.name}`;
  let heads: GhBranch[];
  // The listing's ETag is stored only after every moved branch has been walked.
  let storeEtag: () => void;
  if (repo.branches === "all") {
    const path = `${base}/branches?per_page=100`;
    const res = await gh.paginate<GhBranch>(path, { owner, conditional: true, deferEtag: true });
    if (!res.changed) {
      report.unchanged.push("branches");
      return 0;
    }
    heads = res.items;
    storeEtag = () => gh.storeEtag(path, res.etag);
  } else {
    const path = `${base}/branches/${encodeURIComponent(state.default_branch!)}`;
    const res = await gh.get<GhBranch>(path, { owner, conditional: true });
    if (!res) {
      report.unchanged.push("branches");
      return 0;
    }
    heads = [res.data];
    storeEtag = () => gh.storeEtag(path, res.etag);
  }

  const known = new Map(sql.exec<{ name: string; sha: string }>(`SELECT name, sha FROM branches WHERE repo = ?`, repo.name).map((b) => [b.name, b.sha]));
  // Walk the default branch first so commits are attributed to it rather than to feature branches.
  heads.sort((a, b) => Number(b.name === state.default_branch) - Number(a.name === state.default_branch));

  let added = 0;
  for (const head of heads) {
    if (known.get(head.name) === head.commit.sha) continue;
    added += await walkBranch(sql, gh, owner, repo.name, head, state.floor, now);
    sql.exec(
      `INSERT INTO branches (repo, name, sha) VALUES (?, ?, ?) ON CONFLICT (repo, name) DO UPDATE SET sha = excluded.sha`,
      repo.name, head.name, head.commit.sha,
    );
  }
  if (repo.branches === "all") {
    const live = new Set(heads.map((h) => h.name));
    for (const name of known.keys()) if (!live.has(name)) sql.exec(`DELETE FROM branches WHERE repo = ? AND name = ?`, repo.name, name);
  }
  storeEtag();
  return added;
}

/**
 * Lists a branch's commits newest-first since the floor, stopping after the first page that reaches
 * commits already mirrored (the rest of the history is then known too).
 */
async function walkBranch(sql: Sql, gh: GitHub, owner: string, repo: string, head: GhBranch, floor: string, now: Date): Promise<number> {
  const isKnown = (sha: string) => sql.exec(`SELECT 1 FROM commits WHERE repo = ? AND sha = ?`, repo, sha).length > 0;
  const res = await gh.paginate<GhCommit>(`/repos/${repo}/commits?sha=${head.commit.sha}&since=${floor}&per_page=100`, {
    owner,
    maxPages: 20,
    stop: (page) => page.some((c) => isKnown(c.sha)),
  });
  let added = 0;
  for (const c of res.items) {
    if (isKnown(c.sha)) continue;
    sql.exec(
      `INSERT INTO commits (repo, sha, author_login, author_name, author_email, committer_login, authored_at, committed_at,
         message, parents, files_status, branch, html_url, first_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      repo, c.sha, c.author?.login ?? null, c.commit.author.name, c.commit.author.email, c.committer?.login ?? null,
      normalizeIso(c.commit.author.date), normalizeIso(c.commit.committer.date), c.commit.message.slice(0, MAX_BODY),
      c.parents.length, c.parents.length > 1 ? "merge" : "pending", head.name, c.html_url, toIso(now),
    );
    added++;
  }
  return added;
}

/** Returns true if pending work remains. */
async function fetchCommitFiles(sql: Sql, gh: GitHub, config: DashboardConfig, reports: RepoReport[]): Promise<boolean> {
  const queues = config.repos.map((r) => ({
    repo: r.name,
    shas: sql.exec<{ sha: string }>(`SELECT sha FROM commits WHERE repo = ? AND files_status = 'pending' ORDER BY authored_at DESC`, r.name).map((x) => x.sha),
  }));
  while (queues.some((q) => q.shas.length)) {
    for (const q of queues) {
      const sha = q.shas.shift();
      if (!sha) continue;
      if (gh.exhausted || gh.requests >= gh.maxRequests) return true;
      await fetchOneCommit(sql, gh, q.repo, sha);
      reports.find((r) => r.repo === q.repo)!.commitFiles++;
    }
  }
  return false;
}

async function fetchOneCommit(sql: Sql, gh: GitHub, repo: string, sha: string): Promise<void> {
  const [owner] = repo.split("/");
  // Commits with >300 files paginate their file list (GitHub caps at 3000).
  let url: string | undefined = `/repos/${repo}/commits/${sha}`;
  let stats: GhCommit["stats"];
  const files: NonNullable<GhCommit["files"]> = [];
  let pages = 0;
  while (url && pages < 10) {
    const res: { data: GhCommit; next?: string } | null = await gh.get<GhCommit>(url, { owner });
    stats ??= res!.data.stats;
    files.push(...(res!.data.files ?? []));
    url = res!.next;
    pages++;
  }
  for (const f of files) {
    sql.exec(
      `INSERT OR REPLACE INTO commit_files (repo, sha, path, status, additions, deletions, previous_path) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      repo, sha, f.filename, f.status, f.additions, f.deletions, f.previous_filename ?? null,
    );
  }
  sql.exec(
    `UPDATE commits SET additions = ?, deletions = ?, files_count = ?, files_status = ? WHERE repo = ? AND sha = ?`,
    stats?.additions ?? null, stats?.deletions ?? null, files.length, url ? "truncated" : "done", repo, sha,
  );
}

function maxIso(...values: string[]): string {
  return values.reduce((a, b) => (normalizeIso(b) > normalizeIso(a) ? b : a));
}

/** GitHub sometimes returns offsets ("+02:00") in commit dates; normalize to UTC Z form. */
export function normalizeIso(s: string): string {
  return /T\d\d:\d\d:\d\dZ$/.test(s) ? s : toIso(new Date(s));
}

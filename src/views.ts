import type { DashboardConfig, UserConfig } from "./config";
import type { Sql } from "./db";
import { addDays, localDate, localDayRange, startOfLocalDay, toIso } from "./time";

/**
 * Analytical views, derived live from the mirror on each request. Nothing here is stored. Raw
 * numbers only, with no thresholds or judgements.
 */

const DAY = 86_400_000;

// --- people ---

interface CommitAuthorRow { author_login: string | null; author_email: string | null; author_name: string | null }

/** Maps a commit to a configured person: GitHub login first, then configured email/name aliases. */
export function commitPerson(c: CommitAuthorRow, users: UserConfig[]): string | null {
  if (c.author_login) {
    const u = users.find((u) => u.login.toLowerCase() === c.author_login!.toLowerCase());
    return u ? u.login : null;
  }
  const email = c.author_email?.toLowerCase();
  const name = c.author_name?.toLowerCase();
  const u = users.find((u) => u.aliases?.some((a) => a.toLowerCase() === email || a.toLowerCase() === name));
  return u ? u.login : null;
}

/** Login (case-insensitive) → configured login, for non-commit rows. */
function teamLogin(login: string | null, users: UserConfig[]): string | null {
  if (!login) return null;
  return users.find((u) => u.login.toLowerCase() === login.toLowerCase())?.login ?? null;
}

// --- per-person activity ---

export interface ActivityCounts { commits: number; opened: number; merged: number; comments: number; reviewComments: number }

export function activityOverview(sql: Sql, cfg: DashboardConfig, endDate: string, days: number) {
  const startDate = addDays(endDate, -(days - 1));
  const from = toIso(startOfLocalDay(startDate, cfg.timezone));
  const to = localDayRange(endDate, cfg.timezone)[1];
  const dates = Array.from({ length: days }, (_, i) => addDays(startDate, i));
  const grid = new Map<string, Map<string, ActivityCounts>>();
  for (const u of cfg.users) grid.set(u.login, new Map(dates.map((d) => [d, { commits: 0, opened: 0, merged: 0, comments: 0, reviewComments: 0 }])));
  const bump = (login: string | null, at: string, key: keyof ActivityCounts) => {
    const cell = login ? grid.get(login)?.get(localDate(at, cfg.timezone)) : undefined;
    if (cell) cell[key]++;
  };

  for (const c of sql.exec<CommitAuthorRow & { authored_at: string }>(
    `SELECT author_login, author_email, author_name, authored_at FROM commits WHERE authored_at >= ? AND authored_at < ? AND parents <= 1`, from, to,
  )) bump(commitPerson(c, cfg.users), c.authored_at, "commits");
  for (const i of sql.exec<{ author: string; created_at: string }>(`SELECT author, created_at FROM items WHERE created_at >= ? AND created_at < ?`, from, to)) {
    bump(teamLogin(i.author, cfg.users), i.created_at, "opened");
  }
  for (const i of sql.exec<{ author: string; merged_at: string }>(`SELECT author, merged_at FROM items WHERE merged_at >= ? AND merged_at < ?`, from, to)) {
    bump(teamLogin(i.author, cfg.users), i.merged_at, "merged");
  }
  for (const c of sql.exec<{ kind: string; author: string; created_at: string }>(`SELECT kind, author, created_at FROM comments WHERE created_at >= ? AND created_at < ?`, from, to)) {
    bump(teamLogin(c.author, cfg.users), c.created_at, c.kind === "review" ? "reviewComments" : "comments");
  }

  return {
    timezone: cfg.timezone,
    dates,
    coverageFrom: coverageFrom(sql),
    people: cfg.users.map((u) => ({
      login: u.login,
      name: u.name ?? u.login,
      days: dates.map((d) => ({ date: d, ...grid.get(u.login)!.get(d)! })),
    })),
  };
}

export function personDay(sql: Sql, cfg: DashboardConfig, login: string, date: string) {
  const user = cfg.users.find((u) => u.login.toLowerCase() === login.toLowerCase()) ?? { login };
  const [from, to] = localDayRange(date, cfg.timezone);

  const commitRows = sql.exec<CommitAuthorRow & {
    repo: string; sha: string; message: string; authored_at: string; additions: number | null; deletions: number | null;
    files_count: number | null; files_status: string; branch: string; html_url: string; parents: number;
  }>(`SELECT * FROM commits WHERE authored_at >= ? AND authored_at < ? ORDER BY authored_at`, from, to)
    .filter((c) => commitPerson(c, [user]) !== null);

  const commits = commitRows.map((c) => {
    const files = sql.exec<{ path: string; additions: number; deletions: number }>(
      `SELECT path, additions, deletions FROM commit_files WHERE repo = ? AND sha = ?`, c.repo, c.sha,
    );
    const dirs = new Map<string, number>();
    for (const f of files) dirs.set(dirOf(f.path, 2), (dirs.get(dirOf(f.path, 2)) ?? 0) + f.additions + f.deletions);
    return {
      repo: c.repo, sha: c.sha, headline: c.message.split("\n")[0], at: c.authored_at, branch: c.branch,
      additions: c.additions, deletions: c.deletions, files: c.files_count, filesStatus: c.files_status,
      merge: c.parents > 1, url: c.html_url,
      topDirs: [...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([dir, lines]) => ({ dir, lines })),
    };
  });

  type ItemRow = { repo: string; number: number; kind: string; title: string; state: string; html_url: string; created_at: string; closed_at: string | null; merged_at: string | null; draft: number };
  const pick = (i: ItemRow, at: string) => ({ repo: i.repo, number: i.number, kind: i.kind, title: i.title, state: i.state, draft: !!i.draft, merged: !!i.merged_at, url: i.html_url, at });
  const opened = sql.exec<ItemRow>(`SELECT * FROM items WHERE lower(author) = lower(?) AND created_at >= ? AND created_at < ? ORDER BY created_at`, login, from, to)
    .map((i) => pick(i, i.created_at));
  const merged = sql.exec<ItemRow>(`SELECT * FROM items WHERE lower(author) = lower(?) AND merged_at >= ? AND merged_at < ? ORDER BY merged_at`, login, from, to)
    .map((i) => pick(i, i.merged_at!));
  const closed = sql.exec<ItemRow>(
    `SELECT * FROM items WHERE lower(author) = lower(?) AND merged_at IS NULL AND closed_at >= ? AND closed_at < ? ORDER BY closed_at`, login, from, to,
  ).map((i) => pick(i, i.closed_at!));

  const commentRows = sql.exec<{
    kind: string; repo: string; number: number; created_at: string; body: string; path: string | null; html_url: string;
    title: string | null; item_kind: string | null; item_url: string | null;
  }>(
    `SELECT c.kind, c.repo, c.number, c.created_at, c.body, c.path, c.html_url, i.title, i.kind AS item_kind, i.html_url AS item_url
     FROM comments c LEFT JOIN items i ON i.repo = c.repo AND i.number = c.number
     WHERE lower(c.author) = lower(?) AND c.created_at >= ? AND c.created_at < ? ORDER BY c.created_at`,
    login, from, to,
  );
  const threads = new Map<string, { repo: string; number: number; title: string | null; kind: string | null; url: string; comments: unknown[] }>();
  for (const c of commentRows) {
    const key = `${c.repo}#${c.number}`;
    if (!threads.has(key)) {
      threads.set(key, {
        repo: c.repo, number: c.number, title: c.title, kind: c.item_kind,
        url: c.item_url ?? `https://github.com/${c.repo}/issues/${c.number}`, comments: [],
      });
    }
    threads.get(key)!.comments.push({ kind: c.kind, at: c.created_at, path: c.path, url: c.html_url, excerpt: excerpt(c.body) });
  }

  return {
    login: user.login, name: (user as UserConfig).name ?? user.login, date, timezone: cfg.timezone, range: [from, to],
    coverageFrom: coverageFrom(sql),
    commits, opened, merged, closed, threads: [...threads.values()],
  };
}

function excerpt(body: string | null): string {
  const text = (body ?? "").replace(/```[\s\S]*?```/g, "[code]").replace(/\s+/g, " ").trim();
  return text.length > 220 ? `${text.slice(0, 217)}…` : text;
}

// --- repo issue health ---

export function repoHealth(sql: Sql, cfg: DashboardConfig, now = new Date()) {
  const nowIso = toIso(now);
  const ago = (days: number) => toIso(new Date(now.getTime() - days * DAY));
  const ageDays = (iso: string) => (now.getTime() - Date.parse(iso)) / DAY;

  return cfg.repos.map(({ name: repo }) => {
    const state = sql.exec<{ floor: string; last_success_at: string | null }>(`SELECT floor, last_success_at FROM repo_state WHERE repo = ?`, repo)[0];
    const open = sql.exec<{ number: number; kind: string; title: string; draft: number; created_at: string; comments: number; assignees: string; labels: string; html_url: string }>(
      `SELECT number, kind, title, draft, created_at, comments, assignees, labels, html_url FROM items WHERE repo = ? AND state = 'open'`, repo,
    );
    const openIssues = open.filter((i) => i.kind === "issue");
    const openPrs = open.filter((i) => i.kind === "pr");
    const noComments = openIssues.filter((i) => i.comments === 0).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const issueAges = openIssues.map((i) => ageDays(i.created_at)).sort((a, b) => a - b);
    const oldestOpen = [...openIssues].sort((a, b) => a.created_at.localeCompare(b.created_at))[0];

    const count = (q: string, ...b: unknown[]) => sql.exec<{ n: number }>(q, ...b)[0].n;
    const windowCounts = (days: number) => ({
      days,
      issuesOpened: count(`SELECT count(*) AS n FROM items WHERE repo = ? AND kind = 'issue' AND created_at >= ?`, repo, ago(days)),
      issuesClosed: count(`SELECT count(DISTINCT e.number) AS n FROM item_events e JOIN items i USING (repo, number) WHERE e.repo = ? AND i.kind = 'issue' AND e.event = 'closed' AND e.at >= ?`, repo, ago(days)),
      prsOpened: count(`SELECT count(*) AS n FROM items WHERE repo = ? AND kind = 'pr' AND created_at >= ?`, repo, ago(days)),
      prsMerged: count(`SELECT count(*) AS n FROM items WHERE repo = ? AND kind = 'pr' AND merged_at >= ?`, repo, ago(days)),
      // Windows reaching back before the mirror started undercount closes; flag them.
      complete: !!state && state.floor <= ago(days),
    });

    // Weekly opened vs closed issues since the mirror's floor (max 12 weeks), Monday-start in the configured tz.
    const weeks: { week: string; opened: number; closed: number }[] = [];
    if (state) {
      const today = localDate(now, cfg.timezone);
      const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
      let weekStart = addDays(today, -weekday);
      const floorDate = localDate(state.floor, cfg.timezone);
      for (let i = 0; i < 12 && addDays(weekStart, 6) >= floorDate; i++) {
        const from = toIso(startOfLocalDay(weekStart, cfg.timezone));
        const to = toIso(startOfLocalDay(addDays(weekStart, 7), cfg.timezone));
        weeks.unshift({
          week: weekStart,
          opened: count(`SELECT count(*) AS n FROM items WHERE repo = ? AND kind = 'issue' AND created_at >= ? AND created_at < ?`, repo, from, to),
          closed: count(`SELECT count(DISTINCT e.number) AS n FROM item_events e JOIN items i USING (repo, number) WHERE e.repo = ? AND i.kind = 'issue' AND e.event = 'closed' AND e.at >= ? AND e.at < ?`, repo, from, to),
        });
        weekStart = addDays(weekStart, -7);
      }
    }

    return {
      repo,
      coverageFrom: state?.floor ?? null,
      lastSync: state?.last_success_at ?? null,
      asOf: nowIso,
      openIssues: openIssues.length,
      openPrs: openPrs.length,
      draftPrs: openPrs.filter((p) => p.draft).length,
      openIssuesNoComments: noComments.length,
      oldestNoComment: noComments[0] ? { number: noComments[0].number, title: noComments[0].title, url: noComments[0].html_url, ageDays: ageDays(noComments[0].created_at) } : null,
      unassignedOpenIssues: openIssues.filter((i) => i.assignees === "[]").length,
      unlabelledOpenIssues: openIssues.filter((i) => i.labels === "[]").length,
      medianOpenIssueAgeDays: median(issueAges),
      oldestOpenIssue: oldestOpen ? { number: oldestOpen.number, title: oldestOpen.title, url: oldestOpen.html_url, ageDays: ageDays(oldestOpen.created_at) } : null,
      windows: [windowCounts(7), windowCounts(30)],
      weeks,
    };
  });
}

function median(sorted: number[]): number | null {
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// --- PR ages ---

export function openPrs(sql: Sql, cfg: DashboardConfig, now = new Date()) {
  const rows = sql.exec<{
    repo: string; number: number; title: string; author: string | null; draft: number; created_at: string; updated_at: string;
    html_url: string; requested_reviewers: string | null; comments: number; labels: string; review_comments: number;
  }>(
    `SELECT i.*, (SELECT count(*) FROM comments c WHERE c.kind = 'review' AND c.repo = i.repo AND c.number = i.number) AS review_comments
     FROM items i WHERE i.kind = 'pr' AND i.state = 'open' ORDER BY i.created_at`,
  );
  return {
    asOf: toIso(now),
    repos: cfg.repos.map((r) => r.name),
    prs: rows.map((p) => ({
      repo: p.repo, number: p.number, title: p.title, author: p.author, team: !!teamLogin(p.author, cfg.users),
      draft: !!p.draft, createdAt: p.created_at, updatedAt: p.updated_at, url: p.html_url,
      ageDays: (now.getTime() - Date.parse(p.created_at)) / DAY,
      idleDays: (now.getTime() - Date.parse(p.updated_at)) / DAY,
      requestedReviewers: p.requested_reviewers ? (JSON.parse(p.requested_reviewers) as string[]) : [],
      comments: p.comments, reviewComments: p.review_comments, labels: JSON.parse(p.labels) as string[],
    })),
  };
}

// --- code churn ---

export interface ChurnQuery { from: string; to: string; depth: number; repo?: string; who?: string; exclude: boolean }

export function churn(sql: Sql, cfg: DashboardConfig, q: ChurnQuery) {
  const from = toIso(startOfLocalDay(q.from, cfg.timezone));
  const to = toIso(startOfLocalDay(addDays(q.to, 1), cfg.timezone));
  const multiRepo = !q.repo && cfg.repos.length > 1;
  const excluders = cfg.churnExclude.map(globToRegExp);

  const rows = sql.exec<CommitAuthorRow & { repo: string; sha: string; path: string; additions: number; deletions: number }>(
    `SELECT f.repo, f.sha, f.path, f.additions, f.deletions, c.author_login, c.author_email, c.author_name
     FROM commit_files f JOIN commits c ON c.repo = f.repo AND c.sha = f.sha
     WHERE c.authored_at >= ? AND c.authored_at < ? AND c.parents <= 1 ${q.repo ? "AND f.repo = ?" : ""}`,
    ...[from, to, ...(q.repo ? [q.repo] : [])],
  );

  const dirs = new Map<string, { dir: string; repo: string; additions: number; deletions: number; files: Set<string>; commits: Set<string>; people: Set<string> }>();
  let excludedLines = 0;
  const commitsSeen = new Set<string>();
  for (const r of rows) {
    const person = commitPerson(r, cfg.users);
    if (q.who === "team" && !person) continue;
    if (q.who && q.who !== "team" && q.who !== "all" && person?.toLowerCase() !== q.who.toLowerCase()) continue;
    if (q.exclude && excluders.some((re) => re.test(r.path))) {
      excludedLines += r.additions + r.deletions;
      continue;
    }
    commitsSeen.add(`${r.repo}@${r.sha}`);
    const dir = (multiRepo ? `${r.repo.split("/")[1]}/` : "") + dirOf(r.path, q.depth);
    let d = dirs.get(dir);
    if (!d) dirs.set(dir, (d = { dir, repo: r.repo, additions: 0, deletions: 0, files: new Set(), commits: new Set(), people: new Set() }));
    d.additions += r.additions;
    d.deletions += r.deletions;
    d.files.add(r.path);
    d.commits.add(r.sha);
    d.people.add(person ?? r.author_login ?? r.author_name ?? "?");
  }

  const pending = sql.exec<{ n: number }>(
    `SELECT count(*) AS n FROM commits WHERE files_status = 'pending' AND authored_at >= ? AND authored_at < ? ${q.repo ? "AND repo = ?" : ""}`,
    ...[from, to, ...(q.repo ? [q.repo] : [])],
  )[0].n;

  const list = [...dirs.values()]
    .map((d) => ({ dir: d.dir, repo: d.repo, additions: d.additions, deletions: d.deletions, lines: d.additions + d.deletions, files: d.files.size, commits: d.commits.size, people: [...d.people].sort() }))
    .sort((a, b) => b.lines - a.lines);

  return {
    query: q, timezone: cfg.timezone, coverageFrom: coverageFrom(sql),
    totals: { lines: list.reduce((s, d) => s + d.lines, 0), commits: commitsSeen.size, excludedLines, pendingCommits: pending },
    excludePatterns: cfg.churnExclude,
    dirs: list,
  };
}

/** Directory of `path` truncated to `depth` segments; files at the repo root are "(root)". */
export function dirOf(path: string, depth: number): string {
  const parts = path.split("/").slice(0, -1);
  if (!parts.length) return "(root)";
  return parts.slice(0, depth).join("/") + "/";
}

/** `*` matches within a path segment, `**` across segments; a pattern without `/` matches the basename. */
export function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
  return glob.includes("/") ? new RegExp(`^${esc}$`) : new RegExp(`(^|/)${esc}$`);
}

// --- status ---

export function status(sql: Sql, cfg: DashboardConfig) {
  const repos = cfg.repos.map(({ name, branches }) => {
    const s = sql.exec(`SELECT * FROM repo_state WHERE repo = ?`, name)[0] ?? null;
    const n = (q: string) => sql.exec<{ n: number }>(q, name)[0].n;
    return {
      repo: name, branches, state: s,
      counts: {
        issues: n(`SELECT count(*) AS n FROM items WHERE repo = ? AND kind = 'issue'`),
        prs: n(`SELECT count(*) AS n FROM items WHERE repo = ? AND kind = 'pr'`),
        commits: n(`SELECT count(*) AS n FROM commits WHERE repo = ?`),
        pendingCommitFiles: n(`SELECT count(*) AS n FROM commits WHERE repo = ? AND files_status = 'pending'`),
        issueComments: n(`SELECT count(*) AS n FROM comments WHERE repo = ? AND kind = 'issue'`),
        reviewComments: n(`SELECT count(*) AS n FROM comments WHERE repo = ? AND kind = 'review'`),
        branches: n(`SELECT count(*) AS n FROM branches WHERE repo = ?`),
      },
    };
  });
  const log = sql.exec(`SELECT * FROM sync_log ORDER BY id DESC LIMIT 20`).map((r) => ({ ...r, summary: r.summary ? JSON.parse(r.summary as string) : null }));
  return { repos, log, users: cfg.users, timezone: cfg.timezone, pollMinutes: cfg.pollMinutes, backfillSince: cfg.backfillSince ?? null };
}

function coverageFrom(sql: Sql): string | null {
  return sql.exec<{ floor: string | null }>(`SELECT min(floor) AS floor FROM repo_state`)[0]?.floor ?? null;
}

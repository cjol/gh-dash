/**
 * The mirror: a SQLite schema holding GitHub data for the tracked repos. It is the single source of
 * truth for every view and for anything else (e.g. the daily summary cron) that reads team activity.
 *
 * All timestamps are ISO-8601 UTC strings as GitHub returns them ("2026-10-05T08:00:00Z"), so string
 * comparison is chronological comparison.
 */

export interface Sql {
  /** Run one statement and return its rows. */
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): T[];
}

/** Adapter for a Durable Object's `ctx.storage.sql`. */
export function durableObjectSql(storage: DurableObjectStorage): Sql {
  return {
    exec<T>(query: string, ...bindings: unknown[]): T[] {
      return storage.sql.exec(query, ...bindings).toArray() as T[];
    },
  };
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`,

  // ETags for conditional requests, keyed by full URL. Only stored for single-page responses: a 304
  // on page 1 of a multi-page listing says nothing about later pages.
  `CREATE TABLE IF NOT EXISTS http_cache (url TEXT PRIMARY KEY, etag TEXT NOT NULL, updated_at TEXT NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS repo_state (
    repo TEXT PRIMARY KEY,
    floor TEXT NOT NULL,              -- mirror coverage start for commits/comments/closed items
    initial_done INTEGER NOT NULL DEFAULT 0,
    default_branch TEXT,
    issues_cursor TEXT,               -- max updated_at seen on the issues listing
    issue_comments_cursor TEXT,
    review_comments_cursor TEXT,
    last_sync_at TEXT,
    last_success_at TEXT,
    last_error TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS branches (repo TEXT NOT NULL, name TEXT NOT NULL, sha TEXT NOT NULL,
    PRIMARY KEY (repo, name))`,

  // Issues and PRs (GitHub treats PRs as issues; kind distinguishes them).
  `CREATE TABLE IF NOT EXISTS items (
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    kind TEXT NOT NULL,               -- 'issue' | 'pr'
    title TEXT NOT NULL,
    state TEXT NOT NULL,              -- 'open' | 'closed'
    state_reason TEXT,
    draft INTEGER NOT NULL DEFAULT 0,
    author TEXT,
    author_association TEXT,
    assignees TEXT NOT NULL DEFAULT '[]',  -- JSON array of logins
    labels TEXT NOT NULL DEFAULT '[]',     -- JSON array of names
    comments INTEGER NOT NULL DEFAULT 0,   -- GitHub's conversation comment count (includes pre-mirror comments)
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT,
    merged_at TEXT,
    html_url TEXT NOT NULL,
    head_ref TEXT,
    base_ref TEXT,
    requested_reviewers TEXT,         -- JSON array of logins (open PRs only)
    first_seen_at TEXT NOT NULL,
    PRIMARY KEY (repo, number)
  )`,
  `CREATE INDEX IF NOT EXISTS items_author ON items (author, created_at)`,
  `CREATE INDEX IF NOT EXISTS items_state ON items (repo, state, kind)`,

  // State transitions the sync observed (opened is implied by created_at).
  `CREATE TABLE IF NOT EXISTS item_events (
    repo TEXT NOT NULL, number INTEGER NOT NULL,
    event TEXT NOT NULL,              -- 'closed' | 'merged' | 'reopened'
    at TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    PRIMARY KEY (repo, number, event, at)
  )`,
  `CREATE INDEX IF NOT EXISTS item_events_at ON item_events (at)`,

  `CREATE TABLE IF NOT EXISTS commits (
    repo TEXT NOT NULL,
    sha TEXT NOT NULL,
    author_login TEXT,
    author_name TEXT,
    author_email TEXT,
    committer_login TEXT,
    authored_at TEXT NOT NULL,
    committed_at TEXT NOT NULL,
    message TEXT NOT NULL,
    parents INTEGER NOT NULL,
    additions INTEGER,
    deletions INTEGER,
    files_count INTEGER,
    files_status TEXT NOT NULL,       -- 'pending' | 'done' | 'truncated' | 'merge' (merge commits are not expanded)
    branch TEXT,                      -- branch the commit was first discovered on
    html_url TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    PRIMARY KEY (repo, sha)
  )`,
  `CREATE INDEX IF NOT EXISTS commits_author ON commits (author_login, authored_at)`,
  `CREATE INDEX IF NOT EXISTS commits_authored ON commits (authored_at)`,
  `CREATE INDEX IF NOT EXISTS commits_pending ON commits (files_status)`,

  `CREATE TABLE IF NOT EXISTS commit_files (
    repo TEXT NOT NULL, sha TEXT NOT NULL, path TEXT NOT NULL,
    status TEXT, additions INTEGER NOT NULL, deletions INTEGER NOT NULL, previous_path TEXT,
    PRIMARY KEY (repo, sha, path)
  )`,

  // Conversation comments on issues/PRs ('issue') and inline PR review comments ('review').
  `CREATE TABLE IF NOT EXISTS comments (
    kind TEXT NOT NULL,
    id INTEGER NOT NULL,
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    author TEXT,
    author_association TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    body TEXT,
    path TEXT,                        -- review comments: file the comment is on
    html_url TEXT NOT NULL,
    PRIMARY KEY (kind, id)
  )`,
  `CREATE INDEX IF NOT EXISTS comments_author ON comments (author, created_at)`,
  `CREATE INDEX IF NOT EXISTS comments_item ON comments (repo, number)`,

  `CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    requests INTEGER, not_modified INTEGER,
    rate_remaining INTEGER,
    summary TEXT,
    error TEXT
  )`,
];

export function migrate(sql: Sql): void {
  for (const stmt of SCHEMA) sql.exec(stmt);
}

export function getMeta(sql: Sql, key: string): string | undefined {
  return sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key)[0]?.value;
}

export function setMeta(sql: Sql, key: string, value: string): void {
  sql.exec(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, value);
}

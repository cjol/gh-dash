# Team activity dashboard

A personal stats dashboard for what the team is working on across a few repos. It runs as a Cloudflare
Worker. One Durable Object (`GitHubMirror`) mirrors GitHub into its own SQLite storage, and every view is
computed live from that mirror. Nothing derived is stored.

Deployed at https://team-activity.cjols.workers.dev (see [Status](#status) for what it still needs).

## Views

| Tab | What it shows |
| --- | --- |
| **People** | A person × day grid of activity counts: non-merge commits authored, issues/PRs opened, their PRs merged, conversation and review comments. Click a cell to see that person's day: commits (with +/−, files, top directories), items opened/merged/closed, and every thread they commented on, with excerpts. |
| **Issue health** | Raw numbers per repo. Backlog: open issues, issues with no comments yet, age of the oldest uncommented issue, unassigned, unlabelled, median and oldest open-issue age, open PRs and drafts. Flow: issues opened/closed and PRs opened/merged over 7d and 30d. Plus a weekly opened-vs-closed chart. No thresholds. |
| **PR ages** | Every open PR on a log time axis, one row per repo, coloured draft/ready. Hover for details, click to open on GitHub. Filters for repo and team authors, and a table underneath. |
| **Code churn** | Lines added/removed per directory over a chosen period, at a chosen depth, filterable by repo and person, from per-file line counts. Lockfiles and similar are hidden by default (`churnExclude`). |
| **Sync** | Per-repo mirror state, row counts, errors, and recent sync runs (requests, 304s, remaining rate limit). |

Days are calendar days in the configured `timezone`.

## Configuration

Edit `config/dashboard.json`, then redeploy:

```jsonc
{
  "timezone": "Europe/London",
  "pollMinutes": 10,                          // DO alarm interval (POLL_MINUTES var overrides)
  "backfillSince": "2026-09-28T00:00:00Z",   // optional, see below
  "repos": [{ "name": "owner/repo", "branches": "all" }],   // or "default": only the default branch's commits
  "users": [{ "login": "octocat", "name": "Mona", "aliases": ["mona@laptop.local"] }],
  "churnExclude": ["package-lock.json", "*.snap", "dist/**"]
}
```

`aliases` are commit author emails or names, for commits not linked to the person's GitHub account.

### GitHub auth

Use the existing GitHub App. It needs read access to Contents, Issues, Pull requests and Metadata on the
tracked repos:

```sh
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY      # the .pem as GitHub issues it (PKCS#1 is fine)
npx wrangler secret put GITHUB_APP_INSTALLATION_ID  # optional; otherwise looked up per repo owner
```

If no App is configured, `GITHUB_TOKEN` (any PAT) is used instead. Without either, requests go out
anonymously. From Workers that is hopeless: the shared egress IPs are always over GitHub's 60/hour limit.

Optional: `DASHBOARD_PASSWORD` turns on HTTP basic auth for the whole site (any username). It also enables
`POST /api/reset[?repo=owner/name]`, which wipes a repo's mirror so the next sync redoes the initial
sync (for example after changing `backfillSince`).

## How the sync works

Each poll walks a ring of (repo, stage) tasks. The `/repos/{r}/...` endpoints are:

| Stage | Endpoint | Notes |
| --- | --- | --- |
| issues | `issues?state=all&sort=updated&since=<cursor>` | Covers issues and PRs (`pull_request.merged_at`). Records closed/merged/reopened transitions in `item_events`. |
| pulls | `pulls?state=open` | Head/base branch, requested reviewers, draft. |
| issue-comments | `issues/comments?since=<cursor>` | Issue and PR conversation comments. |
| review-comments | `pulls/comments?since=<cursor>` | Inline code review comments. |
| commits | `branches`, then `commits?sha=<head>&since=<floor>` for moved heads | Stops at the first page that reaches known commits, then `commits/{sha}` once per new non-merge commit for per-file line counts. |

What keeps polls cheap:

- **ETags.** Every listing is a conditional request. A 304 doesn't count against the rate limit. ETags are only kept for single-page responses, because a 304 on page 1 says nothing about page 2. The branch-list ETag is only saved after every moved branch has been walked.
- **Cursors.** Cursors are the max `updated_at` seen, not wall-clock time, so the URL stays the same until something changes. A quiet poll is about 5 requests per repo, all 304.
- **Resumable runs.** A run that hits the per-run request cap (`MAX_REQUESTS_PER_RUN`, default 800, kept under Workers' subrequest limit) or GitHub's rate limit saves where it stopped. The next alarm (1 min later, or after the rate-limit reset) continues from there. Commit-detail fetches queue as `files_status = 'pending'`.
- **No Events API**, so the Refresh button really is up to date.

### Initial sync

- **Default (no `backfillSince`):** every open issue and PR. Commits, comments and closes are recorded from now on.
- **With `backfillSince`:** the same, plus everything updated since that date, including closed items, commits with file stats, and comments. Good for checking the views quickly. It only applies to a repo's first sync; use `/api/reset` to redo it.

"Comments, new only" means comments created before the floor are ignored, even if edited later.

### Shared layer for the summary/triage cron

The mirror is the single source of truth. A future cron in this Worker should read it rather than GitHub:

```ts
const mirror = env.MIRROR.get(env.MIRROR.idFromName("mirror"));
const rows = await mirror.select(`SELECT * FROM items WHERE state = 'open' AND kind = 'issue'`);
```

Or add view functions in `src/views.ts` and call them from inside the object. The schema is documented in
`src/db.ts`.

## Development

```sh
npm install
npm test                  # vitest: sync engine against a fake GitHub, views, time zones, App JWT
npm run typecheck
npm run deploy            # wrangler deploy

# Same API + UI on Node with a local SQLite file (handy when wrangler dev can't reach GitHub)
GITHUB_TOKEN=... npm run dev:node -- config/dashboard.json local.sqlite 8787
GITHUB_TOKEN=... npm run sync:local -- config/dashboard.json local.sqlite   # one sync, prints the report
```

Layout: `src/sync.ts` (mirror engine), `src/github.ts` (REST client, App auth, ETags), `src/views.ts`
(analytics), `src/api.ts` (routes), `src/mirror.ts` (Durable Object), `public/` (UI, no build step).

## Status

- **Tests:** the sync engine is tested against an in-memory GitHub (`test/fake-github.ts`). That covers pagination, 304s, since cursors, closes, reopens and merges, comment floors, branch walking, merge commits, resuming after the request cap, and the rate-limit reserve. Also tested: the views, DST-safe day ranges, and PKCS#1 → JWT → installation-token auth.
- **Real GitHub:** a 7-day backfill of `cjol/pumpslop` (22 commits with file stats) synced correctly, and the following poll was all 304s.
- **Deployed Worker:** live, but it has no GitHub credentials yet, so it can't sync. Add the App secrets above. It will then backfill the example OSS repos in `config/dashboard.json` (Hono, Vitest, h3) from 28 Sept. Swap in the real repos and team when ready.

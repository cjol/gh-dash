/**
 * An in-memory GitHub REST API covering the endpoints the sync uses, with the behaviour the sync
 * relies on: `since` filters, sort/direction, Link pagination, ETags/304s, commit ancestry listing
 * and rate-limit headers.
 */

export interface FakeIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  user: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: number;
  labels: string[];
  assignees: string[];
  pr?: { merged_at: string | null; draft: boolean; head: string; base: string; reviewers: string[] };
}

export interface FakeComment {
  id: number;
  number: number;
  user: string;
  created_at: string;
  updated_at: string;
  body: string;
  path?: string;
}

export interface FakeCommit {
  sha: string;
  parents: string[];
  login: string | null;
  name: string;
  email: string;
  date: string;
  message: string;
  files: { filename: string; additions: number; deletions: number; status?: string }[];
}

export interface FakeRepo {
  default_branch: string;
  issues: FakeIssue[];
  issueComments: FakeComment[];
  reviewComments: FakeComment[];
  branches: Record<string, string>;
  commits: Record<string, FakeCommit>;
}

export class FakeGitHub {
  repos: Record<string, FakeRepo> = {};
  calls: { url: string; status: number }[] = [];
  rateRemaining = 5000;

  repo(name: string, default_branch = "main"): FakeRepo {
    return (this.repos[name] ??= { default_branch, issues: [], issueComments: [], reviewComments: [], branches: {}, commits: {} });
  }

  /** Adds a commit on top of `branch` (creating the branch from `from` if new). */
  commit(repoName: string, branch: string, c: Partial<FakeCommit> & { sha: string; date: string }, from?: string): FakeCommit {
    const repo = this.repo(repoName);
    const parent = repo.branches[branch] ?? (from ? repo.branches[from] : undefined);
    const commit: FakeCommit = {
      parents: parent ? [parent] : [], login: "alice", name: "Alice", email: "alice@example.com", message: `commit ${c.sha}`, files: [], ...c,
    };
    repo.commits[commit.sha] = commit;
    repo.branches[branch] = commit.sha;
    return commit;
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const ifNoneMatch = new Headers(init?.headers).get("if-none-match");
    const res = this.route(url);
    let response: Response;
    if (res.status !== 200) {
      response = new Response(JSON.stringify({ message: "Not Found" }), { status: res.status });
    } else {
      const body = JSON.stringify(res.body);
      const etag = `W/"${hash(body)}"`;
      const headers: Record<string, string> = { etag, "x-ratelimit-limit": "5000", "x-ratelimit-resource": "core", "x-ratelimit-reset": "2000000000" };
      if (res.next) headers.link = `<${res.next}>; rel="next"`;
      if (ifNoneMatch === etag) {
        headers["x-ratelimit-remaining"] = String(this.rateRemaining);
        response = new Response(null, { status: 304, headers });
      } else {
        headers["x-ratelimit-remaining"] = String(--this.rateRemaining);
        response = new Response(body, { status: 200, headers });
      }
    }
    this.calls.push({ url: url.pathname + url.search, status: response.status });
    return response;
  };

  private route(url: URL): { status: number; body?: unknown; next?: string } {
    const m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/);
    const repo = m && this.repos[m[1]];
    if (!repo) return { status: 404 };
    const name = m[1];
    const rest = m[2] ?? "";
    const q = url.searchParams;
    const since = q.get("since");
    const page = <T>(all: T[]) => {
      const per = Number(q.get("per_page") ?? 30);
      const n = Number(q.get("page") ?? 1);
      const items = all.slice((n - 1) * per, n * per);
      let next: string | undefined;
      if (n * per < all.length) {
        const nu = new URL(url);
        nu.searchParams.set("page", String(n + 1));
        next = nu.toString();
      }
      return { status: 200, body: items, next };
    };
    const byUpdated = <T extends { updated_at: string }>(xs: T[]) => {
      const filtered = since ? xs.filter((x) => x.updated_at >= since) : xs;
      const sorted = [...filtered].sort((a, b) => a.updated_at.localeCompare(b.updated_at));
      return q.get("direction") === "asc" ? sorted : sorted.reverse();
    };

    if (rest === "") return { status: 200, body: { default_branch: repo.default_branch } };
    if (rest === "/issues") {
      const state = q.get("state") ?? "open";
      let xs = repo.issues.filter((i) => state === "all" || i.state === state);
      xs = q.get("sort") === "updated" ? byUpdated(xs) : [...xs].sort((a, b) => b.created_at.localeCompare(a.created_at));
      return page(xs.map((i) => this.issueJson(name, i)));
    }
    if (rest === "/pulls") {
      const xs = repo.issues.filter((i) => i.pr && i.state === "open");
      return page(xs.map((i) => ({
        number: i.number, draft: i.pr!.draft, head: { ref: i.pr!.head }, base: { ref: i.pr!.base },
        requested_reviewers: i.pr!.reviewers.map((login) => ({ login })), requested_teams: [],
      })));
    }
    if (rest === "/issues/comments" || rest === "/pulls/comments") {
      const review = rest === "/pulls/comments";
      const xs = byUpdated(review ? repo.reviewComments : repo.issueComments);
      return page(xs.map((c) => ({
        id: c.id, user: { login: c.user }, created_at: c.created_at, updated_at: c.updated_at, body: c.body, path: c.path,
        html_url: `https://github.com/${name}/pull/${c.number}#c${c.id}`,
        [review ? "pull_request_url" : "issue_url"]: `https://api.github.com/repos/${name}/${review ? "pulls" : "issues"}/${c.number}`,
      })));
    }
    if (rest === "/branches") {
      return page(Object.entries(repo.branches).sort().map(([n, sha]) => ({ name: n, commit: { sha } })));
    }
    const branch = rest.match(/^\/branches\/(.+)$/);
    if (branch) {
      const sha = repo.branches[decodeURIComponent(branch[1])];
      return sha ? { status: 200, body: { name: decodeURIComponent(branch[1]), commit: { sha } } } : { status: 404 };
    }
    if (rest === "/commits") {
      // All ancestors of `sha`, newest first, committed at/after `since`.
      const seen = new Set<string>();
      const stack = [q.get("sha") ?? repo.branches[repo.default_branch]];
      while (stack.length) {
        const sha = stack.pop()!;
        if (seen.has(sha) || !repo.commits[sha]) continue;
        seen.add(sha);
        stack.push(...repo.commits[sha].parents);
      }
      const xs = [...seen].map((s) => repo.commits[s]).filter((c) => !since || c.date >= since).sort((a, b) => b.date.localeCompare(a.date));
      return page(xs.map((c) => this.commitJson(name, c, false)));
    }
    const one = rest.match(/^\/commits\/([0-9a-z]+)$/);
    if (one) {
      const c = repo.commits[one[1]];
      return c ? { status: 200, body: this.commitJson(name, c, true) } : { status: 404 };
    }
    return { status: 404 };
  }

  private issueJson(repo: string, i: FakeIssue) {
    return {
      number: i.number, title: i.title, state: i.state, state_reason: null, draft: i.pr?.draft,
      user: { login: i.user }, author_association: "MEMBER", assignees: i.assignees.map((login) => ({ login })),
      labels: i.labels.map((name) => ({ name })), comments: i.comments, created_at: i.created_at, updated_at: i.updated_at,
      closed_at: i.closed_at, html_url: `https://github.com/${repo}/${i.pr ? "pull" : "issues"}/${i.number}`,
      ...(i.pr ? { pull_request: { merged_at: i.pr.merged_at } } : {}),
    };
  }

  private commitJson(repo: string, c: FakeCommit, detail: boolean) {
    return {
      sha: c.sha, html_url: `https://github.com/${repo}/commit/${c.sha}`, parents: c.parents.map((sha) => ({ sha })),
      author: c.login ? { login: c.login } : null, committer: c.login ? { login: c.login } : null,
      commit: { message: c.message, author: { name: c.name, email: c.email, date: c.date }, committer: { date: c.date } },
      ...(detail
        ? {
            stats: { additions: c.files.reduce((s, f) => s + f.additions, 0), deletions: c.files.reduce((s, f) => s + f.deletions, 0) },
            files: c.files.map((f) => ({ status: "modified", ...f })),
          }
        : {}),
    };
  }
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

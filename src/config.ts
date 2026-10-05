import raw from "../config/dashboard.json";

export type BranchMode = "default" | "all";

export interface RepoConfig {
  /** "owner/name" */
  name: string;
  /** Which branches to collect commits from. "all" walks every branch pushed to the repo. */
  branches: BranchMode;
}

export interface UserConfig {
  login: string;
  name?: string;
  /** Extra commit author emails/names for commits not linked to the GitHub account. */
  aliases?: string[];
}

export interface DashboardConfig {
  timezone: string;
  pollMinutes: number;
  /** ISO timestamp. When set, the initial sync also pulls closed items, commits and comments since this date. */
  backfillSince?: string;
  repos: RepoConfig[];
  users: UserConfig[];
  /** Glob-ish patterns (`*`, `**`) excluded from the churn view by default. */
  churnExclude: string[];
}

export function parseConfig(input: unknown): DashboardConfig {
  const c = input as Record<string, unknown>;
  if (!c || typeof c !== "object") throw new Error("config: expected an object");
  const repos = (c.repos as unknown[] | undefined) ?? [];
  if (!Array.isArray(repos) || repos.length === 0) throw new Error("config: repos must be a non-empty array");
  const users = (c.users as unknown[] | undefined) ?? [];
  const backfill = c.backfillSince as string | undefined;
  if (backfill !== undefined && Number.isNaN(Date.parse(backfill))) {
    throw new Error(`config: backfillSince is not a valid date: ${backfill}`);
  }
  return {
    timezone: (c.timezone as string) || "UTC",
    pollMinutes: Number(c.pollMinutes) > 0 ? Number(c.pollMinutes) : 10,
    backfillSince: backfill ? new Date(backfill).toISOString().replace(/\.\d{3}Z$/, "Z") : undefined,
    repos: repos.map((r) => {
      const repo = typeof r === "string" ? { name: r } : (r as Record<string, unknown>);
      const name = String(repo.name);
      if (!/^[\w.-]+\/[\w.-]+$/.test(name)) throw new Error(`config: bad repo name ${name}`);
      const branches = repo.branches === "default" ? "default" : "all";
      return { name, branches };
    }),
    users: users.map((u) => {
      const user = typeof u === "string" ? { login: u } : (u as Record<string, unknown>);
      return {
        login: String(user.login),
        name: user.name ? String(user.name) : undefined,
        aliases: Array.isArray(user.aliases) ? user.aliases.map(String) : undefined,
      };
    }),
    churnExclude: Array.isArray(c.churnExclude) ? c.churnExclude.map(String) : [],
  };
}

export const config: DashboardConfig = parseConfig(raw);

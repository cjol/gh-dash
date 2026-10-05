import { DurableObject } from "cloudflare:workers";
import { handleApi } from "./api";
import { config } from "./config";
import { durableObjectSql, migrate, type Sql } from "./db";
import { GitHub } from "./github";
import { runLoggedSync, type SyncReport } from "./sync";

export interface Env {
  MIRROR: DurableObjectNamespace<GitHubMirror>;
  ASSETS: Fetcher;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  GITHUB_TOKEN?: string;
  /** Overrides config pollMinutes. */
  POLL_MINUTES?: string;
  /** Requests per sync run (Workers caps subrequests per invocation); the next run picks up the rest. */
  MAX_REQUESTS_PER_RUN?: string;
  /** When set, the whole site requires HTTP basic auth with this password (any username). */
  DASHBOARD_PASSWORD?: string;
}

/**
 * The single GitHub mirror (one instance, named "mirror"). Owns the SQLite copy of GitHub data, keeps
 * it fresh on an alarm, and answers view queries from it. Other features (e.g. the daily summary &
 * triage cron) should read through this object too, via `select()` or new view functions, rather
 * than calling GitHub.
 */
export class GitHubMirror extends DurableObject<Env> {
  private sql: Sql;
  private inflight: Promise<SyncReport> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = durableObjectSql(ctx.storage);
    ctx.blockConcurrencyWhile(async () => migrate(this.sql));
  }

  private get pollMs(): number {
    return (Number(this.env.POLL_MINUTES) || config.pollMinutes) * 60_000;
  }

  async alarm(): Promise<void> {
    let report: SyncReport | undefined;
    try {
      report = await this.sync("alarm");
    } catch (e) {
      // Logged in sync_log; don't rethrow, or the runtime's own alarm retries would race the reschedule.
      console.error("sync failed", e);
    } finally {
      // Partial runs (request cap / rate limit) continue soon, but not before the rate limit resets.
      const resetAt = report?.rateReset && (report.rateRemaining ?? 99) < 10 ? Date.parse(report.rateReset) + 5_000 : 0;
      const next = report?.incomplete ? Math.max(Date.now() + 60_000, resetAt) : Date.now() + this.pollMs;
      await this.ctx.storage.setAlarm(next);
    }
  }

  /** Runs a sync, or joins the one already running. */
  sync(trigger: string): Promise<SyncReport> {
    this.inflight ??= runLoggedSync(this.sql, this.github(), config, trigger).finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  private github(): GitHub {
    const gh = new GitHub(this.env, this.sql);
    gh.maxRequests = Number(this.env.MAX_REQUESTS_PER_RUN) || 800;
    return gh;
  }

  /** Read-only SQL over the mirror, for other features in this Worker (e.g. the summary cron). */
  async select(query: string, ...bindings: unknown[]): Promise<Record<string, unknown>[]> {
    if (!/^\s*(SELECT|WITH)\b/i.test(query) || /;\s*\S/.test(query)) throw new Error("select() only runs a single SELECT");
    return this.sql.exec(query, ...bindings);
  }

  async fetch(request: Request): Promise<Response> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 2_000);
    return handleApi(
      {
        sql: this.sql,
        config,
        sync: (trigger) => this.sync(trigger),
        syncing: () => !!this.inflight,
        nextSyncAt: async () => {
          const alarm = await this.ctx.storage.getAlarm();
          return alarm ? new Date(alarm).toISOString() : null;
        },
        authMode: () => this.github().authMode,
      },
      request,
    );
  }
}

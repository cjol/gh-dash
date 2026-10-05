import type { DashboardConfig } from "./config";
import type { Sql } from "./db";
import type { SyncReport } from "./sync";
import { isDate, localDate } from "./time";
import { activityOverview, churn, openPrs, personDay, repoHealth, status } from "./views";

/** What the API needs from its host (the Durable Object, or the local dev server). */
export interface ApiHost {
  sql: Sql;
  config: DashboardConfig;
  sync(trigger: string): Promise<SyncReport>;
  syncing(): boolean;
  nextSyncAt(): Promise<string | null>;
  authMode(): string;
}

const json = (data: unknown, init?: ResponseInit) => Response.json(data, { ...init, headers: { "cache-control": "no-store" } });

export async function handleApi(host: ApiHost, request: Request): Promise<Response> {
  const { sql, config } = host;
  const url = new URL(request.url);
  const p = url.searchParams;
  const today = localDate(new Date(), config.timezone);

  try {
    switch (`${request.method} ${url.pathname}`) {
      case "GET /api/config":
        return json({ timezone: config.timezone, today, repos: config.repos, users: config.users, churnExclude: config.churnExclude });
      case "GET /api/status":
        return json({ ...status(sql, config), nextSyncAt: await host.nextSyncAt(), syncing: host.syncing(), authMode: host.authMode() });
      case "POST /api/refresh":
        return json(await host.sync("manual"));
      case "GET /api/activity": {
        const end = isDate(p.get("end")) ? p.get("end")! : today;
        const days = Math.min(Math.max(Number(p.get("days")) || 14, 1), 60);
        return json(activityOverview(sql, config, end, days));
      }
      case "GET /api/person": {
        const login = p.get("login");
        if (!login) return json({ error: "login required" }, { status: 400 });
        return json(personDay(sql, config, login, isDate(p.get("date")) ? p.get("date")! : today));
      }
      case "GET /api/health":
        return json({ repos: repoHealth(sql, config) });
      case "GET /api/prs":
        return json(openPrs(sql, config));
      case "GET /api/churn": {
        const to = isDate(p.get("to")) ? p.get("to")! : today;
        const from = isDate(p.get("from")) ? p.get("from")! : to;
        return json(churn(sql, config, {
          from: from <= to ? from : to, to: from <= to ? to : from,
          depth: Math.min(Math.max(Number(p.get("depth")) || 2, 1), 6),
          repo: p.get("repo") || undefined, who: p.get("who") || undefined, exclude: p.get("exclude") !== "0",
        }));
      }
      case "POST /api/reset": {
        // Forget a repo's mirror (or everything) so the next sync redoes the initial sync, e.g. after
        // changing backfillSince.
        const repo = p.get("repo");
        const where = repo ? "WHERE repo = ?" : "";
        const args = repo ? [repo] : [];
        for (const t of ["items", "item_events", "commits", "commit_files", "comments", "branches", "repo_state"]) sql.exec(`DELETE FROM ${t} ${where}`, ...args);
        sql.exec(`DELETE FROM http_cache`);
        return json({ reset: repo ?? "all" });
      }
      case "POST /api/ensure-alarm":
        return json({ ok: true });
    }
    return json({ error: "not found" }, { status: 404 });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

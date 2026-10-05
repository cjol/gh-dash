/**
 * Local dev server: the same API and UI as the Worker, but on Node with a node:sqlite file instead of
 * a Durable Object. Useful where `wrangler dev` can't reach GitHub with credentials.
 *
 *   GITHUB_TOKEN=... npx tsx scripts/dev-server.ts [config.json] [db.sqlite] [port]
 *
 * Syncs on start and every pollMinutes; the Refresh button works as in production.
 */
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { handleApi } from "../src/api";
import { parseConfig } from "../src/config";
import { migrate } from "../src/db";
import { GitHub } from "../src/github";
import { runLoggedSync, type SyncReport } from "../src/sync";
import { nodeSql } from "./node-sql";

const config = parseConfig(JSON.parse(readFileSync(process.argv[2] ?? "config/dashboard.json", "utf8")));
const sql = nodeSql(process.argv[3] ?? "local.sqlite");
const port = Number(process.argv[4] ?? 8787);
migrate(sql);

const env = { GITHUB_TOKEN: process.env.GITHUB_TOKEN };
let inflight: Promise<SyncReport> | undefined;
let nextSync = Date.now();
const sync = (trigger: string) => {
  inflight ??= runLoggedSync(sql, new GitHub(env, sql), config, trigger).finally(() => (inflight = undefined));
  return inflight;
};
const tick = async () => {
  await sync("alarm").catch((e) => console.error("sync failed:", e));
  nextSync = Date.now() + config.pollMinutes * 60_000;
  setTimeout(tick, config.pollMinutes * 60_000);
};
tick();

const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (url.pathname.startsWith("/api/")) {
    const response = await handleApi(
      { sql, config, sync, syncing: () => !!inflight, nextSyncAt: async () => new Date(nextSync).toISOString(), authMode: () => new GitHub(env, sql).authMode },
      new Request(url, { method: req.method }),
    );
    res.writeHead(response.status, { "content-type": "application/json" });
    res.end(await response.text());
    return;
  }
  const file = join("public", url.pathname === "/" ? "index.html" : url.pathname);
  if (!existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`http://localhost:${port}`));

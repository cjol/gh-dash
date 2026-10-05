/**
 * Runs the real sync + views against a local SQLite file, outside Workers. Handy for poking at the
 * mirror without deploying:
 *
 *   GITHUB_TOKEN=... npx tsx scripts/local-sync.ts [config.json] [db.sqlite]
 *
 * Run it twice to see the second pass come back as 304s.
 */
import { readFileSync } from "node:fs";
import { parseConfig } from "../src/config";
import { migrate } from "../src/db";
import { GitHub } from "../src/github";
import { syncAll } from "../src/sync";
import { localDate } from "../src/time";
import { activityOverview, churn, openPrs, personDay, repoHealth } from "../src/views";
import { nodeSql } from "./node-sql";

const cfg = parseConfig(JSON.parse(readFileSync(process.argv[2] ?? "config/dashboard.json", "utf8")));
const sql = nodeSql(process.argv[3] ?? "local.sqlite");
migrate(sql);
const gh = new GitHub({ GITHUB_TOKEN: process.env.GITHUB_TOKEN }, sql);
const report = await syncAll(sql, gh, cfg);
console.log(JSON.stringify(report, null, 2));

const today = localDate(new Date(), cfg.timezone);
const view = process.env.VIEW as "activity" | "person" | "health" | "prs" | "churn" | undefined;
if (view) {
  const out = {
    activity: () => activityOverview(sql, cfg, today, 14),
    person: () => personDay(sql, cfg, process.env.LOGIN ?? cfg.users[0].login, process.env.DATE ?? today),
    health: () => repoHealth(sql, cfg),
    prs: () => openPrs(sql, cfg),
    churn: () => churn(sql, cfg, { from: process.env.FROM ?? today, to: today, depth: 2, exclude: true }),
  }[view]();
  console.log(JSON.stringify(out, null, 2));
}

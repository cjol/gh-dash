import { DatabaseSync } from "node:sqlite";
import type { Sql } from "../src/db";

/** node:sqlite stand-in for a Durable Object's SQL storage (tests and the local sync script). */
export function nodeSql(path = ":memory:"): Sql & { db: DatabaseSync } {
  const db = new DatabaseSync(path);
  return {
    db,
    exec<T>(query: string, ...bindings: unknown[]): T[] {
      return db.prepare(query).all(...(bindings as never[])) as T[];
    },
  };
}

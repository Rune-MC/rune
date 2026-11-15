import { sqlStore, type SqlExecutor, type Value } from "@rune/storage";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export interface SqliteDatabase {
  prepare(sql: string): {
    get(...parameters: Value[]): unknown;
    run(...parameters: Value[]): { changes: number | bigint };
  };
}

export function sqliteStore(db: SqliteDatabase, table?: string) {
  return sqlStore("sqlite", {
    async one(sql, parameters) {
      return db.prepare(sql).get(...parameters) as Awaited<ReturnType<SqlExecutor["one"]>>;
    },
    async run(sql, parameters) {
      return Number(db.prepare(sql).run(...parameters).changes);
    },
  }, table);
}

export async function connect(path: string, options: { table?: string } = {}) {
  const db = new DatabaseSync(path.startsWith("file:") ? fileURLToPath(path) : path);
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000");
    const store = await sqliteStore(db, options.table);
    return { database: db, store, async close() { db.close(); } };
  } catch (error) {
    db.close();
    throw error;
  }
}

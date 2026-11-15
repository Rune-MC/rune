import { sqlStore, type SqlExecutor, type Value } from "@rune/storage";
import pg from "pg";

export interface PostgresConnection {
  query(sql: string, values: Value[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

export function postgresStore(pool: PostgresConnection, table?: string) {
  return sqlStore("postgres", {
    async one(sql, parameters) {
      return (await pool.query(sql, [...parameters])).rows[0] as Awaited<ReturnType<SqlExecutor["one"]>>;
    },
    async run(sql, parameters) {
      return (await pool.query(sql, [...parameters])).rowCount ?? 0;
    },
  }, table);
}

export async function connect(uri: string, options: { table?: string } = {}) {
  const pool = new pg.Pool({ connectionString: uri, max: 4, connectionTimeoutMillis: 5000 });
  pool.on("error", () => { /* Idle connections are discarded. Active queries return their own errors. */ });
  try {
    const store = await postgresStore(pool, options.table);
    return { pool, store, close: () => pool.end() };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

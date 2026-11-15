import { sqlStore, type SqlExecutor, type Value } from "@rune/storage";
import mysql from "mysql2/promise";

export interface MysqlConnection {
  execute(sql: string, values: Value[]): Promise<readonly [unknown, unknown]>;
}

export function mysqlStore(pool: MysqlConnection, table?: string) {
  return sqlStore("mysql", {
    async one(sql, parameters) {
      const [rows] = await pool.execute(sql, [...parameters]);
      return (rows as Array<NonNullable<Awaited<ReturnType<SqlExecutor["one"]>>>>)[0];
    },
    async run(sql, parameters) {
      const [result] = await pool.execute(sql, [...parameters]);
      return (result as { affectedRows: number }).affectedRows;
    },
  }, table);
}

export async function connect(uri: string, options: { table?: string } = {}) {
  const pool = mysql.createPool({ uri, connectionLimit: 4, connectTimeout: 5000, enableKeepAlive: true });
  try {
    const store = await mysqlStore(pool, options.table);
    return { pool, store, close: () => pool.end() };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

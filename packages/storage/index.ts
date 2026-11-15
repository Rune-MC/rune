import { randomBytes } from "node:crypto";
export * from "./connections.ts";
export { paperStore, paperRecords, StorageInputError } from "./paper.ts";

export interface StoredRecord {
  revision: string;
  value: string;
  expiresAt: number | null;
}

/** Persist records and implement the writes atomically across processes. */
export interface RecordStore {
  get(key: string): Promise<StoredRecord | null>;
  insert(key: string, record: StoredRecord): Promise<boolean>;
  replace(key: string, revision: string, record: StoredRecord): Promise<boolean>;
  remove(key: string, revision: string): Promise<boolean>;
  prune(now?: number): Promise<number>;
}

export interface ConnectedStore {
  store: RecordStore;
  close(): Promise<void>;
}

export function record(value: unknown, expiresAt: number | null = null): StoredRecord {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError("Store values must be JSON serializable");
  return { revision: randomBytes(24).toString("hex"), value: json, expiresAt };
}

/** Read or change a single durable document without losing concurrent updates. */
export function document<T>(store: RecordStore, key: string, createDefault: () => T) {
  if (!/^[A-Za-z0-9:_.-]{1,256}$/.test(key)) throw new TypeError("Invalid storage document key");
  return {
    async read(): Promise<T> {
      const current = await store.get(key);
      return current ? JSON.parse(current.value) as T : createDefault();
    },
    async update(change: (value: T) => T): Promise<T> {
      for (let attempt = 0; attempt < 8; attempt++) {
        const current = await store.get(key);
        const next = change(current ? JSON.parse(current.value) as T : createDefault());
        const entry = record(next);
        const saved = current
          ? await store.replace(key, current.revision, entry)
          : await store.insert(key, entry);
        if (saved) return next;
      }
      throw new Error("Document changed repeatedly. Retry the update.");
    },
  };
}

export function memoryStore(): RecordStore {
  const data = new Map<string, StoredRecord>();
  return {
    async get(key) { return data.get(key) ?? null; },
    async insert(key, entry) {
      if (data.has(key)) return false;
      data.set(key, entry);
      return true;
    },
    async replace(key, revision, entry) {
      if (data.get(key)?.revision !== revision) return false;
      data.set(key, entry);
      return true;
    },
    async remove(key, revision) {
      return data.get(key)?.revision === revision && data.delete(key);
    },
    async prune(now = Date.now()) {
      let removed = 0;
      for (const [key, entry] of data) {
        if (entry.expiresAt !== null && entry.expiresAt <= now && data.delete(key)) removed++;
      }
      return removed;
    },
  };
}

export type Value = string | number | null;
export interface SqlExecutor {
  one(sql: string, parameters: readonly Value[]): Promise<{
    revision: string; payload: string; expires_at: number | string | null;
  } | undefined>;
  run(sql: string, parameters: readonly Value[]): Promise<number>;
}

export async function sqlStore(
  dialect: "sqlite" | "mysql" | "postgres",
  db: SqlExecutor,
  table = "rune_auth",
): Promise<RecordStore> {
  if (!/^[a-z][a-z0-9_]{0,47}$/.test(table)) throw new TypeError("invalid auth table name");
  const quoted = dialect === "mysql" ? "`" + table + "`" : '"' + table + '"';
  const param = (index: number) => dialect === "postgres" ? "$" + index : "?";
  await db.run(`CREATE TABLE IF NOT EXISTS ${quoted} (
    record_key ${dialect === "mysql" ? "VARBINARY(512)" : "VARCHAR(256)"} PRIMARY KEY,
    revision CHAR(48) NOT NULL,
    payload ${dialect === "mysql" ? "LONGTEXT" : "TEXT"} NOT NULL,
    expires_at BIGINT NULL${dialect === "mysql" ? ", INDEX expiry (expires_at)" : ""}
  )`, []);
  if (dialect !== "mysql") {
    await db.run(`CREATE INDEX IF NOT EXISTS "${table}_expiry" ON ${quoted} (expires_at)`, []);
  }
  const select = `SELECT revision, payload, expires_at FROM ${quoted} WHERE record_key = ${param(1)}`;
  const fields = [1, 2, 3, 4].map(param).join(", ");
  const insert = `INSERT INTO ${quoted} (record_key, revision, payload, expires_at) VALUES (${fields})` +
    (dialect === "mysql" ? "" : " ON CONFLICT (record_key) DO NOTHING");
  const update = `UPDATE ${quoted} SET revision=${param(1)}, payload=${param(2)}, expires_at=${param(3)} WHERE record_key=${param(4)} AND revision=${param(5)}`;
  const remove = `DELETE FROM ${quoted} WHERE record_key=${param(1)} AND revision=${param(2)}`;
  return {
    async get(key) {
      const row = await db.one(select, [key]);
      return row ? {
        revision: row.revision, value: row.payload,
        expiresAt: row.expires_at === null ? null : Number(row.expires_at),
      } : null;
    },
    async insert(key, entry) {
      try {
        return await db.run(insert, [key, entry.revision, entry.value, entry.expiresAt]) === 1;
      } catch (error) {
        if (dialect === "mysql" && errorCode(error) === "ER_DUP_ENTRY") return false;
        throw error;
      }
    },
    async replace(key, revision, entry) {
      return await db.run(update, [entry.revision, entry.value, entry.expiresAt, key, revision]) === 1;
    },
    async remove(key, revision) { return await db.run(remove, [key, revision]) === 1; },
    prune(now = Date.now()) {
      return db.run(`DELETE FROM ${quoted} WHERE expires_at <= ${param(1)}`, [now]);
    },
  };
}

export function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

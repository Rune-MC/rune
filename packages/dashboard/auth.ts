import { createAuth, createAuthHandler } from "@rune/web-auth";
import { connections, connectUrl, type RecordStore, type StoredRecord } from "@rune/storage";

const namespace = "rune-dashboard";
const ownerSlot = namespace + ":owner";
const accountPrefix = namespace + ":account:";
type Owner = { lookup: string; value: string };
const wrap = (lookup: string, entry: StoredRecord): StoredRecord =>
  ({ ...entry, value: JSON.stringify({ lookup, value: entry.value } satisfies Owner) });

/** Store every Web Auth account insert in one CAS slot. Account creation and ownership commit together. */
function singleOwner(storage: RecordStore): RecordStore {
  const account = (key: string) => key.startsWith(accountPrefix);
  async function get(key: string) {
    const entry = await storage.get(ownerSlot);
    if (!entry) return null;
    const owner: Owner = JSON.parse(entry.value);
    return owner.lookup === key ? { ...entry, value: owner.value } : null;
  }
  return {
    get: (key) => account(key) ? get(key) : storage.get(key),
    insert: (key, entry) => account(key) ? storage.insert(ownerSlot, wrap(key, entry)) : storage.insert(key, entry),
    async replace(key, revision, entry) {
      if (!account(key)) return storage.replace(key, revision, entry);
      return (await get(key))?.revision === revision && storage.replace(ownerSlot, revision, wrap(key, entry));
    },
    remove: (key, revision) => account(key) ? Promise.resolve(false) : storage.remove(key, revision),
    prune: (now) => storage.prune(now),
  };
}

function localRecords(): RecordStore {
  const storage = rune.store("dashboard-auth");
  return {
    async get(key) { return storage.get<StoredRecord>(key) ?? null; },
    async insert(key, value) {
      if (storage.has(key)) return false;
      storage.set(key, value);
      return true;
    },
    async replace(key, revision, value) {
      if (storage.get<StoredRecord>(key)?.revision !== revision) return false;
      storage.set(key, value);
      return true;
    },
    async remove(key, revision) {
      if (storage.get<StoredRecord>(key)?.revision !== revision) return false;
      storage.delete(key);
      return true;
    },
    async prune(now = Date.now()) {
      let removed = 0;
      for (const [key, entry] of storage.entries() as Array<[string, StoredRecord]>) {
        if (entry.expiresAt != null && entry.expiresAt <= now) { storage.delete(key); removed++; }
      }
      return removed;
    },
  };
}

export async function selectAuthStorage(mode = process.env.RUNE_DASHBOARD_STORAGE ?? "local") {
  if (mode === "local") {
    const store = localRecords();
    return () => store;
  }
  if (mode.startsWith("reuse:")) {
    const name = mode.slice(6);
    return () => {
      const connection = connections.get(name);
      if (!connection) throw new Error("Dashboard storage connection is unavailable: " + name);
      return connection.store;
    };
  }
  if (mode === "connect" && process.env.RUNE_DASHBOARD_DB_URL) {
    const connection = await connectUrl(process.env.RUNE_DASHBOARD_DB_URL, { name: false });
    return () => connection.store;
  }
  throw new Error("Set RUNE_DASHBOARD_STORAGE to local, reuse:<name>, or connect with RUNE_DASHBOARD_DB_URL.");
}

export function createDashboardAuth(store: () => RecordStore) {
  const storage: RecordStore = {
    get: (...args) => store().get(...args),
    insert: (...args) => store().insert(...args),
    replace: (...args) => store().replace(...args),
    remove: (...args) => store().remove(...args),
    prune: (...args) => store().prune(...args),
  };
  const auth = createAuth({ store: singleOwner(storage), credentials: { mode: "session" }, namespace });
  return {
    hasOwner: async () => (await storage.get(ownerSlot)) !== null,
    handlers: (origin: string) => createAuthHandler(auth, { origin, allowRegistration: true }),
    prune: auth.pruneExpired,
  };
}

function header(ctx: ServeContext, name: string) {
  return Object.entries(ctx.req.headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

export function loopbackOrigin(ctx: ServeContext): string | null {
  const host = header(ctx, "host");
  if (!host || !/^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/i.test(host)) return null;
  try { return new URL("http://" + host).origin; } catch { return null; }
}

export function authRequest(ctx: ServeContext, origin: string, path: string, method = "GET", body?: Record<string, string>) {
  const headers = new Headers();
  const cookie = header(ctx, "cookie");
  const requestOrigin = header(ctx, "origin");
  if (cookie) headers.set("cookie", cookie);
  if (requestOrigin) headers.set("origin", requestOrigin);
  if (body) headers.set("content-type", "application/json");
  return new Request(origin + path, { method, headers, body: body && JSON.stringify(body) });
}

export function contentType(ctx: ServeContext) {
  return header(ctx, "content-type")?.split(";")[0].trim().toLowerCase();
}

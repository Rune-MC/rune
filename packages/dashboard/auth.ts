import { AsyncLocalStorage } from "node:async_hooks";
import { AuthError, createAuth, createAuthHandler } from "@rune/web-auth";
import { connections, connectUrl, type RecordStore, type StoredRecord } from "@rune/storage";
import { createUserDirectory, namespace } from "./users.ts";

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
  const directory = createUserDirectory(storage);
  const accountKey = (key: string) => key.startsWith(namespace + ":account:");
  const enrollment = new AsyncLocalStorage<{ kind: "owner" } | { kind: "invite"; code: string }>();
  const auth = createAuth({
    credentials: { mode: "session" }, namespace,
    store: {
      get: (key) => accountKey(key) ? directory.credential(key) : storage.get(key),
      async insert(key, row) {
        if (!accountKey(key)) return storage.insert(key, row);
        const context = enrollment.getStore();
        return context?.kind === "owner" ? directory.provisionOwner(key, row) :
          context?.kind === "invite" ? directory.redeem(key, context.code, row) : false;
      },
      replace: (key, revision, row) => accountKey(key)
        ? directory.replaceCredential(key, revision, row) : storage.replace(key, revision, row),
      remove: (key, revision) => accountKey(key) ? Promise.resolve(false) : storage.remove(key, revision),
      prune: storage.prune,
    },
  });
  return {
    directory,
    hasOwner: async () => (await directory.owner()) !== null,
    registerOwner: (login: string, password: string) => enrollment.run({ kind: "owner" }, () => auth.register(login, password)),
    async registerInvite(login: string, password: string, code: string) {
      if (!(await directory.validInvitation(login, code))) throw new AuthError("credentials", "Invalid or expired invitation.");
      return enrollment.run({ kind: "invite", code }, () => auth.register(login, password));
    },
    async recoveryCode(login: string) {
      if (!(await directory.canRecover(login))) return null;
      return auth.createResetCode(login);
    },
    resetPassword: auth.resetPassword,
    handlers: (origin: string) => createAuthHandler(auth, { origin }),
    prune: auth.pruneExpired,
  };
}

export function authErrorStatus(error: AuthError) {
  return { input: 400, credentials: 401, conflict: 409, busy: 429, origin: 403, size: 413 }[error.code];
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

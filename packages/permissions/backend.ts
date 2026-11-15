import { document, type ConnectedStore } from "@rune/storage";
import type { Group } from "./model.ts";

export interface PermissionState {
  groups: Record<string, Group>;
  members: Record<string, string[]>;
}
type Edit = (state: PermissionState) => void;
export const emptyGroup = (): Group => ({ parents: [], rules: {} });
const initial = (): PermissionState => ({ groups: { default: emptyGroup() }, members: {} });
const url = process.env.RUNE_PERMISSIONS_DB_URL?.trim();
const localStore = rune.store("rune-permissions");
let current = url ? initial() : localStore.get<PermissionState>("state") ?? initial();
let onChange = () => {};
let lane = Promise.resolve();
let failedAt = 0;
let warned = false;
const shared = globalThis as typeof globalThis & {
  runePermissionsDatabase?: { url: string; connection: Promise<ConnectedStore> };
};

async function open(url: string): Promise<ConnectedStore> {
  const protocol = url.slice(0, url.indexOf(":"));
  switch (protocol) {
    case "file": return (await import("@rune/sqlite")).connect(url);
    case "mysql": return (await import("@rune/mysql")).connect(url);
    case "postgres":
    case "postgresql": return (await import("@rune/postgres")).connect(url);
    case "mongodb":
    case "mongodb+srv": return (await import("@rune/mongo")).connect(url);
    case "redis":
    case "rediss": return (await import("@rune/redis")).connect(url);
    default: throw new Error("Unknown RUNE_PERMISSIONS_DB_URL protocol");
  }
}

async function remote() {
  if (!url) throw new Error("No remote database configured");
  let cached = shared.runePermissionsDatabase;
  if (cached?.url !== url) {
    if (cached) void cached.connection.then((db) => db.close()).catch(() => {});
    const connection = open(url);
    cached = { url, connection };
    shared.runePermissionsDatabase = cached;
  }
  try {
    return document((await cached.connection).store, "permissions:state:v1", initial);
  } catch (error) {
    if (shared.runePermissionsDatabase === cached) delete shared.runePermissionsDatabase;
    throw error;
  }
}

function serial<T>(job: () => Promise<T>): Promise<T> {
  const result = lane.then(job);
  lane = result.then(() => {}, () => {});
  return result;
}

function publish(next: PermissionState) {
  if (JSON.stringify(current) === JSON.stringify(next)) return;
  current = next;
  onChange();
}

function failed() {
  const cached = shared.runePermissionsDatabase;
  if (cached) {
    delete shared.runePermissionsDatabase;
    void cached.connection.then((db) => db.close()).catch(() => {});
  }
  if (!warned) {
    console.warn("Permissions cannot read its configured database. Check the adapter and connection settings.");
    warned = true;
  }
  const now = Date.now();
  failedAt ||= now;
  if (now - failedAt > 30_000) rune.schedule.nextTick(() => publish(initial()));
}

export function state() { return current; }

export class PermissionInputError extends Error {}

export function startBackend(refresh: () => void) {
  onChange = refresh;
  if (!url) return;
  let reading = false;
  const poll = () => {
    if (reading) return;
    reading = true;
    void serial(async () => {
      try {
        const next = await (await remote()).read();
        failedAt = 0;
        warned = false;
        rune.schedule.nextTick(() => publish(next));
      } catch {
        failed();
      } finally {
        reading = false;
      }
    });
  };
  rune.schedule.nextTick(poll);
  rune.schedule.everyTicks(poll, 100);
}

export function change(edit: Edit, notify: (message: string) => void, success: string) {
  const update = (snapshot: PermissionState) => {
    const next = structuredClone(snapshot);
    edit(next);
    return next;
  };
  if (!url) {
    try {
      const next = update(current);
      localStore.set("state", next);
      publish(next);
      notify(success);
    } catch (error) {
      if (!(error instanceof PermissionInputError)) throw error;
      notify(error.message);
    }
    return;
  }
  void serial(async () => {
    try {
      const next = await (await remote()).update(update);
      failedAt = 0;
      warned = false;
      rune.schedule.nextTick(() => { publish(next); notify(success); });
    } catch (error) {
      if (!(error instanceof PermissionInputError)) failed();
      const message = error instanceof PermissionInputError ? error.message : "Permissions database update failed.";
      rune.schedule.nextTick(() => notify(message));
    }
  });
}

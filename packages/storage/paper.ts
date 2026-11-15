import { connections, connectUrl } from "./connections.ts";
import { document, type ConnectedStore } from "./index.ts";

interface LocalStore {
  has(key: string): boolean;
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): unknown;
  entries(): Array<[string, unknown]>;
}

interface PaperHost {
  store(name: string): LocalStore;
  schedule: {
    nextTick(callback: () => void): unknown;
    everyTicks(callback: () => void, ticks: number): unknown;
  };
}

export class StorageInputError extends Error {}
type Mode = { kind: "auto" | "local" } | { kind: "reuse"; name: string } | { kind: "connect"; url: string; name?: string };

function modeFor(id: string): Mode {
  const env = "RUNE_" + id.replaceAll("-", "_").toUpperCase();
  const choice = process.env[env + "_STORAGE"]?.trim();
  const url = process.env[env + "_DB_URL"]?.trim();
  if (choice === "local") return { kind: "local" };
  if (choice === "auto" || (!choice && !url)) return { kind: "auto" };
  if (choice?.startsWith("reuse:") && choice.length > 6) return { kind: "reuse", name: choice.slice(6) };
  if (url && (!choice || choice === "connect" || (choice.startsWith("connect:") && choice.length > 8))) {
    return { kind: "connect", url, name: choice?.startsWith("connect:") ? choice.slice(8) : undefined };
  }
  throw new Error(`Invalid ${env}_STORAGE selection or missing ${env}_DB_URL`);
}

interface StoreOptions<T> {
  id: string;
  localName: string;
  initial: () => T;
  localKey?: string;
  remoteKey?: string;
  readLegacy?: (entries: Array<[string, unknown]>) => T;
  normalize?: (value: T) => T;
  clearAfterMs?: number;
}

/** Keep a synchronous snapshot for Bukkit handlers and commit asynchronous edits atomically. */
export function paperStore<T>(host: PaperHost, options: StoreOptions<T>) {
  const { id, initial, normalize = (value) => value } = options;
  const mode = modeFor(id);
  const local = mode.kind === "local" || mode.kind === "auto" ? host.store(options.localName) : undefined;
  const localKey = options.localKey ?? "$document";
  const remoteKey = options.remoteKey ?? `paper:${id}:v1`;
  const legacy = options.readLegacy && local ? local.entries() : [];
  const hasLocal = local?.has(localKey) || legacy.length > 0;
  const localValue = () => normalize(local?.get<T>(localKey) ?? options.readLegacy?.(legacy) ?? initial());
  let selected: Exclude<Mode, { kind: "auto" | "local" }> | "local" | undefined =
    mode.kind === "reuse" || mode.kind === "connect" ? mode
      : mode.kind === "local" || hasLocal ? "local" : undefined;
  let current = selected === "local" ? localValue() : initial();
  let ready = selected === "local";
  let owned: ConnectedStore | undefined;
  let queue = Promise.resolve();
  let polling = false;
  let failedAt = 0;
  const listeners = new Set<(before: T, after: T) => void>();

  function publish(value: T) {
    const previous = current;
    current = value;
    ready = true;
    if (JSON.stringify(previous) !== JSON.stringify(value)) {
      for (const listener of listeners) listener(previous, value);
    }
  }
  function serialize(job: () => Promise<void>) {
    const work = queue.then(job);
    queue = work.catch((error) => console.error(`[${id}] Storage callback failed`, error));
  }
  async function database() {
    if (!selected || selected === "local") throw new Error("Database has not been selected");
    const connection = selected.kind === "reuse" ? connections.get(selected.name)
      : (owned ??= await connectUrl(selected.url, { name: selected.name ?? id }));
    if (!connection) throw new Error("Named database connection is unavailable");
    return document(connection.store, remoteKey, initial);
  }
  function failed() {
    if (owned) {
      const closing = owned;
      owned = undefined;
      void closing.close().catch(() => {});
    }
    if (!failedAt) {
      failedAt = Date.now();
      console.warn(`[${id}] Database unavailable. Check the adapter or named connection.`);
    }
    if (options.clearAfterMs && Date.now() - failedAt >= options.clearAfterMs) {
      host.schedule.nextTick(() => publish(initial()));
    }
  }
  function poll() {
    if (selected === "local" || polling) return;
    polling = true;
    serialize(async () => {
      try {
        const next = normalize(await (await database()).read());
        failedAt = 0;
        host.schedule.nextTick(() => publish(next));
      } catch {
        failed();
      } finally {
        polling = false;
      }
    });
  }
  host.schedule.nextTick(() => {
    if (!selected) {
      const existing = connections.preferred();
      selected = existing ? { kind: "reuse", name: existing } : "local";
      if (selected === "local") publish(localValue());
    }
    poll();
  });
  host.schedule.everyTicks(poll, 100);

  return {
    value: () => current,
    ready: () => ready,
    selection: () => typeof selected === "object" ? selected.kind : selected ?? "initializing",
    onChange: (listener: (before: T, after: T) => void) => listeners.add(listener),
    edit<R>(mutate: (value: T) => R, done: (result: R) => void, reject: (message: string) => void) {
      const errorMessage = (error: unknown) => error instanceof StorageInputError ? error.message : "Storage update failed.";
      if (!selected) { reject("Storage is initializing. Try again shortly."); return; }
      if (selected === "local") {
        let result: R;
        let next: T;
        try {
          next = structuredClone(current);
          result = mutate(next);
          local!.set(localKey, next);
        } catch (error) { reject(errorMessage(error)); return; }
        publish(next);
        done(result);
        return;
      }
      serialize(async () => {
        try {
          let result!: R;
          const next = await (await database()).update((value) => {
            const snapshot = normalize(value);
            result = mutate(snapshot);
            return snapshot;
          });
          failedAt = 0;
          host.schedule.nextTick(() => { publish(next); done(result); });
        } catch (error) {
          if (!(error instanceof StorageInputError)) failed();
          host.schedule.nextTick(() => reject(errorMessage(error)));
        }
      });
    },
  };
}

export function paperRecords<T>(host: PaperHost, id: string, localName: string) {
  return paperStore<Record<string, T>>(host, {
    id, localName, initial: () => ({}),
    readLegacy: (rows) => Object.fromEntries(rows) as Record<string, T>,
  });
}

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { connections, memoryStore, paperRecords, shareConnection } from "@rune/storage";
import { connect as sqlite } from "@rune/sqlite";

function paperHost(legacy: [string, unknown][] = []) {
  const rows = new Map(legacy);
  const ticks: Array<() => void> = [];
  const timers: Array<() => void> = [];
  const host = {
    store() {
      return {
        has: (key: string) => rows.has(key),
        get: <T>(key: string) => rows.get(key) as T | undefined,
        set: <T>(key: string, value: T) => rows.set(key, value),
        entries: () => [...rows.entries()],
      };
    },
    schedule: {
      nextTick: (callback: () => void) => ticks.push(callback),
      everyTicks: (callback: () => void) => timers.push(callback),
    },
  };
  return {
    host, rows,
    async flush() {
      for (let i = 0; i < 4; i++) {
        for (const tick of ticks.splice(0)) tick();
        await nextTurn();
      }
    },
  };
}

test("named connections unregister without affecting another open connection", async () => {
  const a = await sqlite(":memory:", { name: "alpha" });
  const b = await sqlite(":memory:", { name: "beta" });
  try {
    assert.equal(connections.get("alpha")?.store, a.store);
    assert.equal(connections.get("beta")?.store, b.store);
    await a.close();
    assert.equal(connections.get("alpha"), undefined);
    assert.equal(connections.get("beta")?.store, b.store);
  } finally { await a.close(); await b.close(); }
});

test("plugins reuse a named connection using distinct documents, and old local data stays local", async () => {
  const shared = shareConnection({ store: memoryStore(), async close() {} }, "fixture", "default");
  try {
    const { host, flush } = paperHost();
    const homes = paperRecords<number>(host, "test-homes", "homes");
    const warps = paperRecords<number>(host, "test-warps", "warps");
    const existing = paperHost([["saved", 42]]);
    const local = paperRecords<number>(existing.host, "test-pref", "preferences");
    await flush();
    assert.equal(homes.selection(), "reuse");
    assert.equal(warps.selection(), "reuse");
    assert.equal(local.selection(), "local");
    assert.equal(local.value().saved, 42);
    homes.edit((draft) => { draft.point = 1; }, () => {}, assert.fail);
    warps.edit((draft) => { draft.point = 2; }, () => {}, assert.fail);
    local.edit((draft) => { draft.saved++; }, () => {}, assert.fail);
    await flush();
    assert.equal(homes.value().point, 1);
    assert.equal(warps.value().point, 2);
    assert.deepEqual(existing.rows.get("$document"), { saved: 43 });
    assert.ok(await shared.store.get("paper:test-homes:v1"));
    assert.ok(await shared.store.get("paper:test-warps:v1"));
  } finally { await shared.close(); }
});

test("explicit modes choose local, reuse or a separate connection", async () => {
  const temp = await mkdtemp(join(tmpdir(), "rune-paper-storage-"));
  const shared = shareConnection({ store: memoryStore(), async close() {} }, "fixture", "ops");
  process.env.RUNE_TEST_LOCAL_STORAGE = "local";
  process.env.RUNE_TEST_REUSE_STORAGE = "reuse:ops";
  process.env.RUNE_TEST_CONNECT_STORAGE = "connect:dedicated";
  process.env.RUNE_TEST_CONNECT_DB_URL = pathToFileURL(join(temp, "dedicated.sqlite")).href;
  try {
    const { host, flush } = paperHost();
    const local = paperRecords<number>(host, "test-local", "local");
    const reuse = paperRecords<number>(host, "test-reuse", "reuse");
    const separate = paperRecords<number>(host, "test-connect", "connect");
    await flush();
    assert.equal(local.selection(), "local");
    assert.equal(reuse.selection(), "reuse");
    assert.equal(separate.selection(), "connect");
    assert.notEqual(connections.get("dedicated")?.store, shared.store);
    reuse.edit((draft) => { draft.key = 1; }, () => {}, assert.fail);
    separate.edit((draft) => { draft.key = 2; }, () => {}, assert.fail);
    await flush();
    assert.ok(await shared.store.get("paper:test-reuse:v1"));
    assert.equal(await shared.store.get("paper:test-connect:v1"), null);
    assert.equal(separate.value().key, 2);
  } finally {
    delete process.env.RUNE_TEST_LOCAL_STORAGE;
    delete process.env.RUNE_TEST_REUSE_STORAGE;
    delete process.env.RUNE_TEST_CONNECT_STORAGE;
    delete process.env.RUNE_TEST_CONNECT_DB_URL;
    await connections.get("dedicated")?.close();
    await shared.close();
    await rm(temp, { recursive: true, force: true });
  }
});

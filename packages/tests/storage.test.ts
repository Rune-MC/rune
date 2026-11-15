import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connect as connectMongo } from "@rune/mongo";
import { connect as connectMysql } from "@rune/mysql";
import { connect as connectPostgres } from "@rune/postgres";
import { connect as connectRedis } from "@rune/redis";
import { connect as connectSqlite } from "@rune/sqlite";
import { document, memoryStore, record, type RecordStore } from "@rune/storage";

async function contract(store: RecordStore) {
  const prefix = randomUUID();
  const key = `${prefix}:atomic`;
  const old = record({ value: 1 });
  const next = record({ value: 2 });
  assert.equal(await store.get(key), null);
  assert.equal(await store.insert(key, old), true);
  assert.equal(await store.insert(key, next), false);
  assert.equal(await store.replace(key, next.revision, next), false);
  assert.equal(await store.replace(key, old.revision, next), true);
  assert.equal(await store.remove(key, old.revision), false);
  assert.deepEqual(await store.get(key), next);
  assert.equal(await store.remove(key, next.revision), true);
  assert.equal(await store.get(key), null);

  const visits = document(store, `${prefix}:count`, () => 0);
  assert.deepEqual(await Promise.all([visits.update((v) => v + 1), visits.update((v) => v + 1)]).then((v) => v.sort()), [1, 2]);
  assert.equal(await visits.read(), 2);
}

test("memory storage atomic contract", async () => { await contract(memoryStore()); });

test("SQLite storage persists through a connection restart", async () => {
  const temp = await mkdtemp(join(tmpdir(), "rune-storage-"));
  try {
    const path = join(temp, "store.sqlite");
    const database = await connectSqlite(path);
    try {
      await contract(database.store);
      await document(database.store, "persistent", () => 0).update((v) => v + 1);
      await database.store.insert("expired", record({}, Date.now() - 1000));
      assert.equal(await database.store.prune(), 1);
    } finally { await database.close(); }
    const reopened = await connectSqlite(path);
    try {
      assert.equal(await document(reopened.store, "persistent", () => 0).read(), 1);
    } finally { await reopened.close(); }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

for (const [name, connect, url] of [
  ["MongoDB", connectMongo, process.env.RUNE_TEST_MONGO],
  ["MySQL", connectMysql, process.env.RUNE_TEST_MYSQL],
  ["PostgreSQL", connectPostgres, process.env.RUNE_TEST_POSTGRES],
  ["Redis", connectRedis, process.env.RUNE_TEST_REDIS],
] as const) {
  test(`${name} storage atomic contract`, { skip: !url }, async () => {
    const database = await connect(url!);
    try { await contract(database.store); } finally { await database.close(); }
  });
}

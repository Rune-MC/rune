import { type RecordStore, type StoredRecord } from "@rune/storage";
import { createClient } from "redis";

export interface RedisConnection {
  get(key: string): Promise<string | null>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

const redisWrite = `
local raw = redis.call("GET", KEYS[1])
if ARGV[1] == "" then
  if raw then return 0 end
elseif not raw or cjson.decode(raw).revision ~= ARGV[1] then
  return 0
end
if ARGV[2] == "" then
  redis.call("DEL", KEYS[1])
elseif ARGV[3] ~= "" then
  redis.call("SET", KEYS[1], ARGV[2], "PXAT", ARGV[3])
else
  redis.call("SET", KEYS[1], ARGV[2])
end
return 1
`;

export function redisStore(client: RedisConnection, prefix = "rune:storage:"): RecordStore {
  if (!prefix) throw new TypeError("Redis prefix must not be empty");
  async function change(key: string, revision: string, entry?: StoredRecord) {
    const changed = await client.eval(redisWrite, {
      keys: [prefix + key],
      arguments: [revision, entry ? JSON.stringify(entry) : "", entry?.expiresAt?.toString() ?? ""],
    });
    return changed === 1;
  }
  return {
    async get(key) {
      const raw = await client.get(prefix + key);
      return raw === null ? null : JSON.parse(raw) as StoredRecord;
    },
    insert: (key, entry) => change(key, "", entry),
    replace: change,
    remove: (key, revision) => change(key, revision),
    async prune() { return 0; }, // Redis expires keys itself.
  };
}

export async function connect(uri: string, options: { prefix?: string } = {}) {
  const client = createClient({ url: uri, disableOfflineQueue: true, socket: { connectTimeout: 5000, reconnectStrategy: false } });
  client.on("error", () => { /* Connection and command failures are returned to their caller. */ });
  try {
    await client.connect();
    return { client, store: redisStore(client, options.prefix), close: () => client.close() };
  } catch (error) {
    if (client.isOpen) client.destroy();
    throw error;
  }
}

import { shareConnection, type ConnectionOptions } from "@rune/storage";
import { errorCode, type RecordStore, type StoredRecord } from "@rune/storage";
import { MongoClient } from "mongodb";

export interface MongoAuthDocument {
  _id: string;
  revision: string;
  value: string;
  expiresAt: Date | null;
}

export interface MongoAuthCollection {
  createIndex(keys: { expiresAt: 1 }, options: { expireAfterSeconds: number }): Promise<unknown>;
  findOne(filter: { _id: string }): Promise<MongoAuthDocument | null>;
  insertOne(document: MongoAuthDocument): Promise<unknown>;
  updateOne(filter: { _id: string; revision: string }, update: { $set: Omit<MongoAuthDocument, "_id"> }): Promise<{ modifiedCount: number }>;
  deleteOne(filter: { _id: string; revision: string }): Promise<{ deletedCount: number }>;
  deleteMany(filter: { expiresAt: { $lte: Date } }): Promise<{ deletedCount: number }>;
}

export async function mongoStore(collection: MongoAuthCollection): Promise<RecordStore> {
  await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  const doc = (entry: StoredRecord) => ({
    revision: entry.revision, value: entry.value,
    expiresAt: entry.expiresAt === null ? null : new Date(entry.expiresAt),
  });
  return {
    async get(key) {
      const data = await collection.findOne({ _id: key });
      return data ? {
        revision: data.revision, value: data.value, expiresAt: data.expiresAt?.getTime() ?? null,
      } : null;
    },
    async insert(key, entry) {
      try {
        await collection.insertOne({ _id: key, ...doc(entry) });
        return true;
      } catch (error) {
        if (errorCode(error) === 11000) return false;
        throw error;
      }
    },
    async replace(key, revision, entry) {
      return (await collection.updateOne({ _id: key, revision }, { $set: doc(entry) })).modifiedCount === 1;
    },
    async remove(key, revision) { return (await collection.deleteOne({ _id: key, revision })).deletedCount === 1; },
    async prune(now = Date.now()) {
      return (await collection.deleteMany({ expiresAt: { $lte: new Date(now) } })).deletedCount;
    },
  };
}

export async function connect(uri: string, { collection = "rune_storage", name }: ConnectionOptions & { collection?: string } = {}) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, maxPoolSize: 4 });
  try {
    await client.connect();
    const store = await mongoStore(client.db().collection<MongoAuthDocument>(collection));
    return shareConnection({ client, store, close: () => client.close() }, "mongo", name);
  } catch (error) {
    await client.close();
    throw error;
  }
}

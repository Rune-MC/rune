import type { ConnectedStore } from "./index.ts";

const registry = new Map<string, ConnectedStore>();
let nextName = 0;

export const connections = {
  provide(name: string, connection: ConnectedStore): () => void {
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(name)) throw new TypeError("Invalid database connection name");
    if (registry.has(name)) throw new Error(`Database connection '${name}' is already open`);
    registry.set(name, connection);
    return () => {
      if (registry.get(name) === connection) registry.delete(name);
    };
  },
  get(name: string) { return registry.get(name); },
  names() { return [...registry.keys()]; },
  preferred() {
    return registry.has("default") ? "default" : registry.keys().next().value;
  },
};

export interface ConnectionOptions { name?: string | false }

/** Register an open adapter connection and remove it when its owner closes it. */
export function shareConnection<T extends ConnectedStore>(connection: T, driver: string, name?: string | false): T {
  if (name === false) return connection;
  let key = name;
  if (key === undefined) {
    do { key = `${driver}-${++nextName}`; } while (registry.has(key));
  }
  let closed = false;
  const registered = {
    ...connection,
    async close() {
      if (closed) return;
      closed = true;
      remove();
      await connection.close();
    },
  };
  const remove = connections.provide(key, registered);
  return registered;
}

interface Adapter {
  connect(url: string, options?: ConnectionOptions): Promise<ConnectedStore>;
}

export async function connectUrl(url: string, options: ConnectionOptions = {}): Promise<ConnectedStore> {
  const protocol = url.slice(0, url.indexOf(":"));
  let driver: string;
  switch (protocol) {
    case "file": driver = "@rune/sqlite"; break;
    case "mysql": driver = "@rune/mysql"; break;
    case "postgres":
    case "postgresql": driver = "@rune/postgres"; break;
    case "mongodb":
    case "mongodb+srv": driver = "@rune/mongo"; break;
    case "redis":
    case "rediss": driver = "@rune/redis"; break;
    default: throw new Error("Unsupported database URL protocol");
  }
  return (await import(driver) as Adapter).connect(url, options);
}

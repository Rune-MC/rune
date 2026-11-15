# @rune/storage

Persist JSON in typed documents and share database connections between Runes.
Use a backend such as
`@rune/sqlite`, `@rune/mongo`, `@rune/mysql`, `@rune/postgres`,
or `@rune/redis` in production. `memoryStore()` is useful for tests.

## Install and write a document

```sh
rune add @rune/storage
rune add @rune/sqlite
```

```typescript
import { document } from "@rune/storage";
import { connect } from "@rune/sqlite";

const database = await connect("./utility.sqlite");
const stats = document(database.store, "stats:lobby", () => ({ visits: 0 }));
const updated = await stats.update((previous) => ({ visits: previous.visits + 1 }));
console.info(updated.visits);
```

Keep update functions free of side effects because a concurrent write can
retry them. Store values must serialize to JSON. Use `RecordStore` to implement
a backend with atomic insert, revision-checked replace and removal, and
expiration cleanup. `record(value, expiresAt)` creates a fresh revision.
The low-level `get` may return an expired record pending deletion. Check the
timestamp before using expiring credentials.

## API

| API | Use |
| --- | --- |
| `document(store, key, defaultValue)` | Read or atomically update one JSON value. Keys may use letters, digits, colons, underscores, dots, and hyphens. |
| `memoryStore()` | A process-local implementation without a database dependency. |
| `record(value, expiresAt?)` | Encode a JSON value with a new revision and optional Unix expiration time in milliseconds. |
| `connectUrl(url, options?)` | Open the installed adapter for `file:`, `mysql:`, `postgresql:`, `mongodb:`, `mongodb+srv:`, `redis:`, or `rediss:`. `postgres:` also works. |
| `connections` | Look up or register a named connection within the current Rune runtime. |
| `paperStore(rune, options)`, `paperRecords(rune, id, localName)` | Wrap plugin state with local or database storage, a cached synchronous snapshot, and writes that report success or failure on the Paper thread. |

`RecordStore` exposes `get`, `insert`, `replace`, `remove`, and `prune`.
Writes return `true` on success. A duplicate insert or a missing or
stale revision returns `false`. `prune` removes expired records and
returns the number removed when the backend performs the cleanup itself.

## Share an open database on Paper

```typescript
import { connect } from "@rune/postgres";
import { connections } from "@rune/storage";

// Open once from a bootstrap Rune. Other Runes reuse the open pool.
const shared = await connect(process.env.DATABASE_URL!, { name: "shared" });
const samePool = connections.get("shared");
```

Every adapter registers the connection when it opens and unregisters it
when the owner calls `close()`. Pass `name: false` for a private connection.
Unnamed connections receive a generated name. Use `connections.names()`
to see available names or `connections.provide(name, connectedStore)` to
register a connection backed by your own driver.

Permissions, Homes, Warps, NPCs, Announcements, Preferences, and the
Sprint Arena example each read their own `RUNE_<PLUGIN>_STORAGE` and
`RUNE_<PLUGIN>_DB_URL` settings. For example, use `RUNE_HOMES_STORAGE`.

| Setting | Behavior |
| --- | --- |
| `auto` (default) | Keep existing local data. With no local data, reuse the open connection named `default` or the first open connection. Fall back to local storage when no connection is open at startup. |
| `local` | Use Rune's local JSON store. |
| `reuse:shared` | Wait for and reuse the named connection. |
| `connect` | Open a separate connection using the plugin's DB URL and register it under the plugin's name. |
| `connect:shared` | Open a separate connection and register it under the given name. |

Install the adapter that matches a new connection's URL. Providing a plugin
DB URL by itself selects `connect`. A plugin selects storage when it starts
and keeps that selection until restart or reload. Local and database
datasets are independent. Stored positions still refer to local world names
on each server. Give shared processes an explicit config when predictable
selection matters.

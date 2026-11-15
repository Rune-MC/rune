# @rune/sqlite

Use SQLite as a database for [@rune/storage](https://runemc.dev/runebook/r/@rune%2Fstorage) documents, [@rune/web-auth](https://runemc.dev/runebook/r/@rune%2Fweb-auth) accounts, or a stateful Paper Rune.

## Install

```sh
rune add @rune/sqlite
```

This adapter uses Node's built-in `node:sqlite` module in Rune's Node runtime. Use a file path or a `file:` URL. Put the file on writable, persistent local storage. Use `:memory:` for disposable tests.

Example file URL:

```text
file:///srv/minecraft/server.sqlite
```

## Open and share a connection

```typescript
import { connect } from "@rune/sqlite";
import { document } from "@rune/storage";

const db = await connect("./server.sqlite", {
  name: "shared",
  table: "rune_auth",
});
const visits = document(db.store, "lobby:visits", () => ({ total: 0 }));
await visits.update(({ total }) => ({ total: total + 1 }));
```

`name` registers the open connection for other Runes in the same server process.
For example, `RUNE_HOMES_STORAGE=reuse:shared` makes Homes use this connection.
Omit the name for a generated name or set it to `false` for a private connection.
Only the connection owner should call `await db.close()` when consumers have stopped.

## Adapter options

`table` defaults to `rune_auth`. `connect` enables WAL and sets SQLite's busy timeout to five seconds. A relative pathname is resolved from the server process's working directory.

`await sqliteStore(database, table?)` wraps an existing `DatabaseSync`-compatible object. `db.database` exposes the database opened by `connect`. When you wrap a driver yourself, you own its lifecycle. See the [shared storage configuration](https://github.com/Rune-MC/rune/tree/main/packages/storage#share-an-open-database-on-paper) for plugin environment variables and connection modes.

# @rune/mysql

Use MySQL as a database for [@rune/storage](https://runemc.dev/runebook/r/@rune%2Fstorage) documents, [@rune/web-auth](https://runemc.dev/runebook/r/@rune%2Fweb-auth) accounts, or a stateful Paper Rune.

## Install

```sh
rune add @rune/mysql
```

Create the database before connecting. Use a `mysql:` URL. The application user needs read and write access and permission to create the table on first use.
Set `DATABASE_URL` in the process environment for this example.
Example URL shape:

```text
mysql://user:password@127.0.0.1:3306/rune
```

## Open and share a connection

```typescript
import { connect } from "@rune/mysql";
import { document } from "@rune/storage";

const db = await connect(process.env.DATABASE_URL!, {
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

`table` defaults to `rune_auth`. The adapter creates the table with an index for expiration, and uses parameterized queries for record operations.

`await mysqlStore(pool, table?)` wraps an existing mysql2-compatible pool. `db.pool` exposes the pool created by `connect`. When you wrap a driver yourself, you own its lifecycle. See the [shared storage configuration](https://github.com/Rune-MC/rune/tree/main/packages/storage#share-an-open-database-on-paper) for plugin environment variables and connection modes.

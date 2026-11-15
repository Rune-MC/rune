# @rune/mongo

Use MongoDB as a database for [@rune/storage](https://runemc.dev/runebook/r/@rune%2Fstorage) documents, [@rune/web-auth](https://runemc.dev/runebook/r/@rune%2Fweb-auth) accounts, or a stateful Paper Rune.

## Install

```sh
rune add @rune/mongo
```

Use a `mongodb:` or `mongodb+srv:` URL with the intended database in its path. The application user needs read and write access to the collection and permission to create the expiration index.
Set `DATABASE_URL` in the process environment for this example.
Example URL shape:

```text
mongodb://user:password@127.0.0.1:27017/rune
```

## Open and share a connection

```typescript
import { connect } from "@rune/mongo";
import { document } from "@rune/storage";

const db = await connect(process.env.DATABASE_URL!, {
  name: "shared",
  collection: "rune_storage",
});
const visits = document(db.store, "lobby:visits", () => ({ total: 0 }));
await visits.update(({ total }) => ({ total: total + 1 }));
```

`name` registers the open connection for other Runes in the same server process.
For example, `RUNE_HOMES_STORAGE=reuse:shared` makes Homes use this connection.
Omit the name for a generated name or set it to `false` for a private connection.
Only the connection owner should call `await db.close()` when consumers have stopped.

## Adapter options

`collection` defaults to `rune_storage`. The adapter ensures a TTL index on `expiresAt`. MongoDB's TTL monitor removes expired records asynchronously.

`await mongoStore(collection)` wraps an existing `MongoAuthCollection`. `db.client` exposes the MongoClient created by `connect`. When you wrap a driver yourself, you own its lifecycle. See the [shared storage configuration](https://github.com/Rune-MC/rune/tree/main/packages/storage#share-an-open-database-on-paper) for plugin environment variables and connection modes.

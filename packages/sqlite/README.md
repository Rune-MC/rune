# SQLite storage

`rune add @rune/sqlite`

Use a pathname, a file URL, or `:memory:` in tests. The adapter uses Node’s built-in SQLite module. Keep the database on local persistent storage. It enables WAL and retries a busy database for up to five seconds.

```typescript
import { connect } from "@rune/sqlite";
import { document } from "@rune/storage";

const db = await connect("./server.sqlite");
const visits = document(db.store, "visits", () => ({ total: 0 }));
await visits.update((value) => ({ total: value.total + 1 }));
// Call await db.close() when the connection is no longer needed.
```

Wrap an existing driver instance with `sqliteStore(database)`.
Use `db.store` with Web Auth, or as a general-purpose record store.

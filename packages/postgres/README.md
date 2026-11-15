# PostgreSQL storage

`rune add @rune/postgres`

Provide a PostgreSQL connection URL whose database already exists. Store operations use parameterized queries. The adapter creates the table and expiration index.

```typescript
import { connect } from "@rune/postgres";
import { document } from "@rune/storage";

const db = await connect(process.env.DATABASE_URL!);
const visits = document(db.store, "visits", () => ({ total: 0 }));
await visits.update((value) => ({ total: value.total + 1 }));
// Call await db.close() when the connection is no longer needed.
```

Wrap an existing driver instance with `postgresStore(pool)`.
Use `db.store` with Web Auth, or as a general-purpose record store.

Pass `{ name: "shared" }` to `connect` to make the existing connection
reusable by other Runes. [Storage configuration](https://github.com/Rune-MC/rune/tree/main/packages/storage#share-an-open-database-on-paper)

# MongoDB storage

`rune add @rune/mongo`

Provide a `mongodb:` or `mongodb+srv:` URL that names the database. The collection uses `_id` for record identity and a TTL index for expiration.

```typescript
import { connect } from "@rune/mongo";
import { document } from "@rune/storage";

const db = await connect(process.env.DATABASE_URL!);
const visits = document(db.store, "visits", () => ({ total: 0 }));
await visits.update((value) => ({ total: value.total + 1 }));
// Call await db.close() when the connection is no longer needed.
```

Wrap an existing driver instance with `mongoStore(collection)`.
Use `db.store` with Web Auth, or as a general-purpose record store.

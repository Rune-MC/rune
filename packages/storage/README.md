# Storage

`rune add @rune/storage`

One interface for reusable persistence. Use a backend such as
`@rune/sqlite`, `@rune/mongo`, `@rune/mysql`, `@rune/postgres`,
or `@rune/redis` in production. `memoryStore()` is useful for tests.

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

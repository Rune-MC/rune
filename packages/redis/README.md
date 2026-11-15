# Redis storage

`rune add @rune/redis`

Provide a `redis:` or `rediss:` URL. The adapter uses atomic Lua writes and Redis-native expiration. Configure persistence if the application must survive a Redis restart.

```typescript
import { connect } from "@rune/redis";
import { document } from "@rune/storage";

const db = await connect(process.env.DATABASE_URL!);
const visits = document(db.store, "visits", () => ({ total: 0 }));
await visits.update((value) => ({ total: value.total + 1 }));
// Call await db.close() when the connection is no longer needed.
```

Wrap an existing driver instance with `redisStore(client)`.
Use `db.store` with Web Auth, or as a general-purpose record store.

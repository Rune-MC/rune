# @rune/redis

Use Redis as a database for [@rune/storage](https://runemc.dev/runebook/r/@rune%2Fstorage) documents, [@rune/web-auth](https://runemc.dev/runebook/r/@rune%2Fweb-auth) accounts, or a stateful Paper Rune.

## Install

```sh
rune add @rune/redis
```

Use a `redis:` or `rediss:` URL and Redis 6.2 or newer. The adapter uses atomic Lua writes and Redis-native expiration. Enable Redis persistence if the data must survive a Redis restart.
Set `DATABASE_URL` in the process environment for this example.
Example URL shape:

```text
redis://127.0.0.1:6379/0
```

## Open and share a connection

```typescript
import { connect } from "@rune/redis";
import { document } from "@rune/storage";

const db = await connect(process.env.DATABASE_URL!, {
  name: "shared",
  prefix: "rune:storage:",
});
const visits = document(db.store, "lobby:visits", () => ({ total: 0 }));
await visits.update(({ total }) => ({ total: total + 1 }));
```

`name` registers the open connection for other Runes in the same server process.
For example, `RUNE_HOMES_STORAGE=reuse:shared` makes Homes use this connection.
Omit the name for a generated name or set it to `false` for a private connection.
Only the connection owner should call `await db.close()` when consumers have stopped.

## Adapter options

`prefix` defaults to `rune:storage:`. Choose a distinct prefix for unrelated applications sharing a Redis database. Expiring records use Redis TTLs, so `store.prune()` returns zero.

`redisStore(client, prefix?)` wraps an already connected node-redis-compatible client. `db.client` exposes the client created by `connect`. When you wrap a driver yourself, you own its lifecycle. See the [shared storage configuration](https://github.com/Rune-MC/rune/tree/main/packages/storage#share-an-open-database-on-paper) for plugin environment variables and connection modes.

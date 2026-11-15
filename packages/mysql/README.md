# MySQL storage

`rune add @rune/mysql`

Provide a MySQL URL whose database already exists. The pool creates its storage table and uses prepared statements. MariaDB uses the same adapter and connection syntax.

```typescript
import { connect } from "@rune/mysql";
import { document } from "@rune/storage";

const db = await connect(process.env.DATABASE_URL!);
const visits = document(db.store, "visits", () => ({ total: 0 }));
await visits.update((value) => ({ total: value.total + 1 }));
// Call await db.close() when the connection is no longer needed.
```

Wrap an existing driver instance with `mysqlStore(pool)`.
Use `db.store` with Web Auth, or as a general-purpose record store.

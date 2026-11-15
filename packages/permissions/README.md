# Permissions

`rune add @rune/permissions`, then restart Paper.

```text
/permissions create builder
/permissions rule builder example.build allow
/permissions rule builder example.admin deny
/permissions member Alice builder true
/permissions create architect
/permissions inherit architect builder true
/permissions inspect Alice
```

Group membership uses UUIDs. The `default` group always applies. Add an
exact Bukkit permission with `allow` or `deny`, and remove its rule with
`unset`. Denies win when two of this Rune's groups disagree. Group
inheritance is transitive and cycles are rejected. Pass `false` to remove a
membership or parent. `/permissions delete <group>` removes a group and
its inherited links and memberships.

Edit commands are limited to server operators. Use one permission manager
for a given set of nodes. The `permissions` service (major version 1)
exposes resolved `groups(uuid)` and `rules(uuid)` for other Runes.

## Database storage

Permissions uses Rune's local store by default. To share state across servers,
install the adapter that matches your URL, set `RUNE_PERMISSIONS_DB_URL` in
the Paper process environment, and restart each server.

| URL scheme | Install |
| --- | --- |
| `file:` | `rune add @rune/sqlite` |
| `mysql:` | `rune add @rune/mysql` |
| `mongodb:`, `mongodb+srv:` | `rune add @rune/mongo` |
| `postgres:`, `postgresql:` | `rune add @rune/postgres` |
| `redis:`, `rediss:` | `rune add @rune/redis` |

The database has independent state from an existing local store. Every
database update uses compare-and-swap. Other servers pick up changes on
their next poll, normally within five seconds. After sustained database
failure, this Rune clears its own cached permission grants until it can
read a valid snapshot again.

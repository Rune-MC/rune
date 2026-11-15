# Rune utility packages

All packages are TypeScript. Paper packages register commands and Bukkit
listeners through Rune's decorators. Install from a Paper server with
`rune add @rune/<name>`, then restart Paper for the command tree and libraries.

| Package | Purpose |
| --- | --- |
| `web-auth` | Password auth, revocable JWTs or opaque sessions, recovery, and Fetch handlers |
| `storage` | Atomic record and typed document interfaces |
| `mongo`, `mysql`, `postgres`, `sqlite`, `redis` | Database adapters |
| `permissions` | Permission groups, timed and scoped grants, Adventure labels, promotion tracks, and audit history |
| `moderation` | Staff GUI and console commands for cases, punishments, reports, channels, and chat controls |
| `paper-ui` | Searchable inventory menus, draft forms, confirmations, and private chat prompts |
| `anticheat` | Alert-first movement and combat monitoring |
| `npcs` | Persistent named villagers, dialogue, and interaction events |
| `homes`, `warps` | Private and shared destinations |
| `announcements`, `preferences` | Rotating messages and player opt-outs |
| `cooldowns`, `rate-limit`, `pagination`, `positions` | Reusable application and Paper helpers |

Each package directory has examples, configuration, and command details.
The Paper packages with persisted data also support local storage, a
shared connection, or their own database. [Storage settings](storage/README.md#share-an-open-database-on-paper)

## Verification

Install npm dependencies in the `mongo`, `mysql`, `postgres`, `redis`,
and `web-auth` directories. From the repository root, run the TypeScript
tests with Node 22.20 or newer.

```sh
node --import ./packages/tests/local-packages.ts --test packages/tests/*.test.ts
```

To include the live database contract tests, set `RUNE_TEST_MONGO`,
`RUNE_TEST_MYSQL`, `RUNE_TEST_POSTGRES`, and `RUNE_TEST_REDIS` to dedicated
test connection URLs. SQLite tests create a temporary file.

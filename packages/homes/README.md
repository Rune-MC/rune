# @rune/homes

Give players private named teleport points that remember the world, position, and facing.

## Install

```sh
rune add @rune/homes
```

Restart Paper, then stand at the spot you want to save and run `/home set`.
Use `/home` to return. The unnamed slot is `home`.

| In-game command | Behavior |
| --- | --- |
| `/home set [name]` | Save or replace a point at your current location. |
| `/home [name]` | Visit one of your saved locations. |
| `/home list` | List your saved names. |
| `/home delete [name]` | Delete a saved point. |

Names accept 1–24 letters, digits, underscores, or hyphens and normalize
to lowercase. Homes are keyed by player UUID. These commands are available in game.

## Settings and storage

| Setting | Default | Range |
| --- | --- | --- |
| `max-homes` | `5` | 1–100 per player |
| `cooldown-seconds` | `10` | 0–300 |

Use `/rune config homes` to view settings. For example,
`/rune config homes max-homes 10` permits ten homes per player. A failed
teleport releases the cooldown. A destination's world must be loaded
and a different Paper plugin can still cancel the teleport.

Use the server environment to set `RUNE_HOMES_STORAGE` to `local`,
`reuse:shared`, or `connect`. For `connect`, install the database adapter and set
`RUNE_HOMES_DB_URL`. The default keeps existing local data and otherwise prefers
an open connection when available. [Storage setup](https://github.com/Rune-MC/rune/tree/main/packages/storage#share-an-open-database-on-paper)

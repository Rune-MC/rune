# @rune/warps

Create named destinations for a Paper server. Use public warps for places
like spawn and the market, and permission-gated warps for staff areas.

## Install and create a warp

```sh
rune add @rune/warps
```

Restart Paper. Stand at the destination and run `/warp set market`.

| Command | Behavior |
| --- | --- |
| `/warp` | List warps you can use. |
| `/warp <name>` | Teleport to that warp in game. |
| `/warp set <name> [restricted]` | Save current position and facing. |
| `/warp delete <name>` | Remove the named warp. |

Saving and deleting require `rune.admin`. Set `restricted` to `true` to
allow only operators and users with `rune.warp.<name>`. Omitting it on an
existing warp preserves that warp's setting. A new warp defaults to public.

Warp names accept 1–24 letters, digits, underscores, or hyphens and normalize
to lowercase. A destination's world must be loaded.

## Storage

Use the server environment to set `RUNE_WARPS_STORAGE` to `local`,
`reuse:shared`, or `connect`. For `connect`, install the database adapter and set
`RUNE_WARPS_DB_URL`. The default keeps existing local data and otherwise prefers
an open connection when available. [Storage setup](https://github.com/Rune-MC/rune/tree/main/packages/storage#share-an-open-database-on-paper)

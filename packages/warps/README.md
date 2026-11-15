# Warps

Choose storage with `RUNE_WARPS_STORAGE`. Use `local`, `reuse:<name>`,
or `connect` with `RUNE_WARPS_DB_URL`. [Storage configuration](https://github.com/Rune-MC/rune/tree/main/packages/storage#share-an-open-database-on-paper)

`rune add @rune/warps`, then restart Paper.

- `/warp` lists destinations you can visit.
- `/warp market` travels to the market.
- `/warp set market` saves the operator's current location.
- `/warp set staff true` requires `rune.warp.staff` to visit the warp.
- `/warp delete market` removes a destination.

Warps persist across restarts. Management requires `rune.admin`.

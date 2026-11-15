# Homes

`rune add @rune/homes`, then restart Paper.

- `/home set [name]` saves your location and facing.
- `/home [name]` teleports to a saved home.
- `/home list` and `/home delete [name]` manage your homes.

The unnamed slot is `home`. Homes are private to the owner's UUID and survive
restart. Use `/rune config homes` to change the per-player limit and
teleport cooldown. Failed teleports release the cooldown.

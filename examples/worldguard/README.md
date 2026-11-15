# @rune/worldguard

Read the IDs of WorldGuard regions at a live Paper location.

## Install

Install WorldGuard and WorldEdit, place this directory in
`plugins/Rune/scripts/`, and restart Paper.

```typescript
import { regionsAt } from "@rune/worldguard";

function isInMarket(player: Player): boolean {
  return regionsAt(player.getLocation()).has("market");
}
```

`regionsAt(location)` returns a read-only set of region IDs. It throws
when either required plugin is unavailable or WorldGuard supplies
virtual region data. The helper checks region membership by location.
Use WorldGuard itself to evaluate region flags or player permissions.

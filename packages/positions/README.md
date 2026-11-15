# Positions

`rune add @rune/positions`

```typescript
import { snapshot, teleportTo } from "@rune/positions";

const points = rune.store("my-positions");
points.set("lobby", snapshot(player.getLocation()));
const result = teleportTo(player, points.get("lobby"));
if (!result.ok) player.sendMessage("The destination is unavailable.");
```

Snapshots are plain JSON with the world name, coordinates, yaw, and pitch.
`resolvePosition` returns a live Bukkit location when the world is loaded.
Teleport on the Paper thread. Bukkit can cancel a teleport and other Runes
can handle that result.

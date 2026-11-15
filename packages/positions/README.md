# @rune/positions

Capture, store, and restore Paper locations from a TypeScript Rune.

## Install and use

```sh
rune add @rune/positions
```

```typescript
import { snapshot, teleportTo, type Position } from "@rune/positions";

const points = rune.store("my-positions");

function saveLobby(player: Player) {
  points.set("lobby", snapshot(player.getLocation()));
}

function visitLobby(player: Player) {
  const result = teleportTo(player, points.get("lobby") as Position | undefined);
  if (!result.ok) player.sendMessage(`Could not teleport: ${result.reason}.`);
}
```

## API

- `snapshot(location)` returns a JSON-compatible `Position` with the world
  name, coordinates, yaw, and pitch.
- `resolvePosition(point)` returns a live Bukkit location or `null` when
  the world is unavailable or the coordinates are invalid.
- `teleportTo(entity, point)` returns `{ ok: true }` on success or
  `{ ok: false, reason: "unavailable" | "cancelled" }`.
- `normalizePositionName(value)` converts a valid name to lowercase or
  returns `null`. Names use 1–24 letters, digits, underscores, or hyphens
  and start with a letter or digit.

Resolve and teleport on the Paper thread. World names refer to the server
where the position is used.

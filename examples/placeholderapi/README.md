# @rune/placeholderapi

Expand PlaceholderAPI tokens in text for a player.

## Install

Install PlaceholderAPI and any expansions your text uses. Copy this directory into `plugins/Rune/scripts/` and restart Paper.

```typescript
import { placeholders } from "@rune/placeholderapi";

function greet(player: Player) {
  const text = placeholders(player, "Welcome, %player_name%!");
  player.sendMessage(text);
}
```

`placeholders(player, text)` accepts a `Player` or `OfflinePlayer` and
returns the expanded string. When PlaceholderAPI is disabled or absent,
the helper returns the original text. Install the matching expansion if
a token is left as written.

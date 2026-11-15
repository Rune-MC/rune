# @rune/cooldowns

Keep one timer per action or player. A successful attempt starts the
cooldown and a rejected attempt returns the remaining wait.

## Install and use

```sh
rune add @rune/cooldowns
```

```typescript
import { createCooldowns } from "@rune/cooldowns";

const abilities = createCooldowns({ maxKeys: 5_000 });

function tryDash(playerId: string) {
  return abilities.tryStart(playerId + ":dash", 3_000);
}
```

## API

| Method | Result |
| --- | --- |
| `tryStart(key, milliseconds)` | Starts a timer on success. Otherwise returns `reason: "cooldown"` with `retryAfterMs`, or `"capacity"` when the key budget is full. |
| `remaining(key)` | Milliseconds left, rounded up, or zero. |
| `clear(key)` | Releases the cooldown, for example when the guarded action fails. |
| `sweep()` | Removes expired entries. A full instance sweeps before refusing new keys. |

The default budget is 10,000 keys. Durations are nonnegative whole
milliseconds, and keys contain 1–256 characters. Entries are in memory for
the lifetime of an instance. Pass a custom `clock` that returns milliseconds
for deterministic tests.

# Cooldowns

`rune add @rune/cooldowns`

```typescript
import { createCooldowns } from "@rune/cooldowns";

const abilities = createCooldowns();
const result = abilities.tryStart(playerId + ":dash", 3_000);
if (result.allowed) dash();
else if (result.reason === "cooldown") showRetry(result.retryAfterMs);
```

Use `remaining(key)` for feedback, `clear(key)` to release a cooldown, and
`sweep()` to remove expired entries. An exhausted key budget rejects new
cooldowns until space becomes available. Each instance lives in memory.

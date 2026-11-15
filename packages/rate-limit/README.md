# @rune/rate-limit

A per-key token bucket for commands, API routes, and other requests.

## Install and use

```sh
rune add @rune/rate-limit
```

```typescript
import { createRateLimiter } from "@rune/rate-limit";

const limiter = createRateLimiter({ capacity: 10, intervalMs: 60_000 });
function checkLimit(accountId: string): Response | undefined {
  const decision = limiter.consume(accountId);
  if (!decision.allowed) {
    return new Response("Too many requests", {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(decision.retryAfterMs / 1000)) },
    });
  }
}
```

## API

Each identity can burst up to `capacity`. Tokens refill continuously, with
a full refill taking `intervalMs`. `consume(key, cost = 1)` returns
`allowed`, `remaining`, and `retryAfterMs`. Set a higher cost for heavier
requests, up to the bucket capacity.

The default budget is 10,000 keys. `sweep()` discards fully refilled entries.
When the budget is exhausted, new keys are rejected until space frees up.
Keep the limiter alive across requests and use a trusted identity such as
an account ID. Use a shared limiter if replicas need one global quota.

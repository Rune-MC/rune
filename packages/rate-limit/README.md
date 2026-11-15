# Rate Limit

`rune add @rune/rate-limit`

```typescript
import { createRateLimiter } from "@rune/rate-limit";

const limiter = createRateLimiter({ capacity: 10, intervalMs: 60_000 });
const decision = limiter.consume(requestIdentity);
if (!decision.allowed) {
  return new Response("Too many requests", {
    status: 429,
    headers: { "Retry-After": String(Math.ceil(decision.retryAfterMs / 1000)) },
  });
}
```

Each identity can burst up to capacity and refills continuously. Give
`consume(key, cost)` a larger cost for heavier operations. Choose a trusted
identity key, such as an authenticated account or a proxy-verified IP. This
limiter is per process. Use a shared limiter for multiple replicas.

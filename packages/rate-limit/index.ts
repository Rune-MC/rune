import { performance } from "node:perf_hooks";

export interface RateLimitOptions {
  capacity: number;
  intervalMs: number;
  maxKeys?: number;
  clock?: () => number;
}

export function createRateLimiter({ capacity, intervalMs, maxKeys = 10_000, clock = () => performance.now() }: RateLimitOptions) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isSafeInteger(intervalMs) ||
      intervalMs < 1 || !Number.isSafeInteger(maxKeys) || maxKeys < 1) {
    throw new RangeError("capacity, intervalMs and maxKeys must be positive integers");
  }
  const buckets = new Map<string, { time: number; tokens: number }>();
  const refill = capacity / intervalMs;
  function sweep(now = clock()) {
    for (const [key, bucket] of buckets) {
      if (bucket.tokens + Math.max(0, now - bucket.time) * refill >= capacity) buckets.delete(key);
    }
  }
  return {
    sweep,
    consume(key: string, cost = 1) {
      if (typeof key !== "string" || !key.length || key.length > 256) throw new TypeError("invalid rate-limit key");
      if (!Number.isSafeInteger(cost) || cost < 1 || cost > capacity) throw new RangeError("invalid token cost");
      const now = clock();
      const previous = buckets.get(key);
      if (!previous && buckets.size >= maxKeys) sweep(now);
      if (!previous && buckets.size >= maxKeys) {
        return { allowed: false, remaining: 0, retryAfterMs: intervalMs };
      }
      const tokens = previous
        ? Math.min(capacity, previous.tokens + Math.max(0, now - previous.time) * refill)
        : capacity;
      const allowed = tokens >= cost;
      const balance = allowed ? tokens - cost : tokens;
      buckets.set(key, { time: now, tokens: balance });
      return {
        allowed,
        remaining: Math.floor(balance),
        retryAfterMs: allowed ? 0 : Math.ceil((cost - tokens) / refill),
      };
    },
  };
}

import { performance } from "node:perf_hooks";

export interface CooldownOptions {
  maxKeys?: number;
  clock?: () => number;
}

export type CooldownDecision =
  | { allowed: true; retryAfterMs: 0 }
  | { allowed: false; retryAfterMs: number; reason: "cooldown" | "capacity" };

export function createCooldowns({ maxKeys = 10_000, clock = () => performance.now() }: CooldownOptions = {}) {
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) throw new RangeError("maxKeys must be positive");
  const deadlines = new Map<string, number>();
  function remaining(key: string, now = clock()) {
    const duration = Math.max(0, (deadlines.get(key) ?? now) - now);
    if (!duration) deadlines.delete(key);
    return Math.ceil(duration);
  }
  function sweep(now = clock()) {
    for (const key of deadlines.keys()) remaining(key, now);
  }
  return {
    remaining,
    sweep,
    clear: (key: string) => deadlines.delete(key),
    tryStart(key: string, milliseconds: number): CooldownDecision {
      if (typeof key !== "string" || !key.length || key.length > 256) throw new TypeError("invalid cooldown key");
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new RangeError("invalid cooldown duration");
      const now = clock();
      const retryAfterMs = remaining(key, now);
      if (retryAfterMs) return { allowed: false, retryAfterMs, reason: "cooldown" };
      if (milliseconds === 0) return { allowed: true, retryAfterMs: 0 };
      if (deadlines.size >= maxKeys) sweep(now);
      if (deadlines.size >= maxKeys) return { allowed: false, retryAfterMs: 0, reason: "capacity" };
      deadlines.set(key, now + milliseconds);
      return { allowed: true, retryAfterMs: 0 };
    },
  };
}

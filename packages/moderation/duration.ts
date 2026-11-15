const fixed = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
type Unit = keyof typeof fixed | "mo" | "y";
export const durationHelp = "Use 30s, 15m, 2h, 3d, 1w, 1mo, 1y, combinations like 1h30m, or permanent.";

/** Years and months use UTC calendar boundaries. Other units are elapsed time. */
export function expiry(input: string, now = Date.now()): number | undefined {
  const value = input.trim().toLowerCase().replace(/\s+/g, "");
  if (value === "perm" || value === "permanent") return undefined;
  if (!/^(?:\d+(?:mo|[smhdwy]))+$/.test(value) || value.length > 60) throw new Error(durationHelp);
  let months = 0;
  let elapsed = 0;
  const seen = new Set<Unit>();
  for (const [, digits, unit] of value.matchAll(/(\d+)(mo|[smhdwy])/g)) {
    const key = unit as Unit;
    const amount = Number(digits);
    if (!Number.isSafeInteger(amount) || amount < 1 || seen.has(key)) throw new Error(durationHelp);
    seen.add(key);
    if (key === "y" || key === "mo") months += amount * (key === "y" ? 12 : 1);
    else elapsed += amount * fixed[key];
  }
  if (months > 1_200 || elapsed > 36_600 * fixed.d) throw new Error("Use a duration up to 100 years.");
  const date = new Date(now);
  if (months) {
    const day = date.getUTCDate();
    date.setUTCMonth(date.getUTCMonth() + months, 1);
    const end = new Date(date);
    end.setUTCMonth(end.getUTCMonth() + 1, 0);
    date.setUTCDate(Math.min(day, end.getUTCDate()));
  }
  const result = date.getTime() + elapsed;
  const limit = new Date(now);
  limit.setUTCFullYear(limit.getUTCFullYear() + 100);
  if (!Number.isFinite(result) || result <= now || result > limit.getTime()) throw new Error("Use a duration up to 100 years.");
  return result;
}

export function remaining(until?: number, now = Date.now()) {
  if (until === undefined) return "Permanent";
  let seconds = Math.max(0, Math.ceil((until - now) / 1_000));
  if (!seconds) return "Expired";
  const parts: string[] = [];
  for (const [name, size] of [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]] as const) {
    const count = Math.floor(seconds / size);
    if (count) parts.push(count + name);
    seconds %= size;
  }
  return parts.slice(0, 2).join(" ");
}

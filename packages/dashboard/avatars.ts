import { avatarKey, playerName } from "./avatar-url.ts";

const fallback = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=", "base64");
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const cache = new Map<string, { body: Uint8Array | null; refreshAt: number; keepUntil: number }>();
const inFlight = new Map<string, Promise<Uint8Array | null>>();
const queued: (() => void)[] = [];
let fetching = 0;

async function fetchImage(url: string): Promise<Uint8Array | null> {
  const limit = 64 * 1024;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(2000), redirect: "error", headers: { Accept: "image/png" },
    });
    if (!response.ok || response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "image/png" || !response.body) {
      await response.body?.cancel();
      return null;
    }
    const reader = response.body.getReader();
    const pieces: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > limit) { await reader.cancel(); return null; }
        pieces.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }

    const image = Buffer.concat(pieces);
    // Both avatar endpoints produce a 40px head. Reject placeholder pixels and truncated responses.
    if (image.length < 45 || !image.subarray(0, 8).equals(pngSignature) || image.toString("ascii", 12, 16) !== "IHDR" ||
        image.readUInt32BE(16) !== 40 || image.readUInt32BE(20) !== 40 ||
        image.toString("ascii", image.length - 8, image.length - 4) !== "IEND") return null;
    return image;
  } catch {
    return null;
  }
}

async function fetchQueued(key: string, username: string | undefined, keepExisting: boolean) {
  if (fetching < 8) fetching++;
  else await new Promise<void>((ready) => queued.push(ready));
  try {
    const first = await fetchImage("https://mc-heads.net/avatar/" + key + "/40");
    if (first || keepExisting) return first;
    const alternate = await fetchImage("https://minotar.net/avatar/" + key + "/40");
    if (alternate || !username) return alternate;
    return await fetchImage("https://mc-heads.net/avatar/" + username + "/40");
  } finally {
    const next = queued.shift();
    if (next) next();
    else fetching--;
  }
}

function refresh(cacheKey: string, key: string, username?: string) {
  const pending = inFlight.get(cacheKey);
  if (pending) return pending;
  if (inFlight.size >= 32) return undefined;
  const initial = cache.get(cacheKey);
  const keepExisting = Boolean(initial?.body && initial.keepUntil > Date.now());
  const job = fetchQueued(key, username, keepExisting).then((image) => {
    const now = Date.now();
    const saved = image
      ? { body: image, refreshAt: now + 60 * 60_000, keepUntil: now + 24 * 60 * 60_000 }
      : { body: initial && initial.keepUntil > now ? initial.body : null,
          refreshAt: now + 15_000, keepUntil: initial?.keepUntil ?? now };
    cache.delete(cacheKey);
    cache.set(cacheKey, saved);
    while (cache.size > 256) cache.delete(cache.keys().next().value!);
    return saved.body;
  }).finally(() => inFlight.delete(cacheKey));
  inFlight.set(cacheKey, job);
  return job;
}

export async function avatar(value: string, name?: string) {
  const username = name && playerName.test(name) ? name.toLowerCase() : undefined;
  const key = avatarKey(value) ?? username;
  if (!key) return { body: fallback, maxAge: 0 };

  const backup = username !== key ? username : undefined;
  const cacheKey = key + "/" + (backup ?? "");
  const saved = cache.get(cacheKey);
  const now = Date.now();
  const recent = saved?.body && saved.keepUntil > now ? saved.body : null;
  if (saved && now < saved.refreshAt) {
    cache.delete(cacheKey);
    cache.set(cacheKey, saved);
    return { body: recent ?? fallback, maxAge: recent ? 300 : 0 };
  }
  const job = refresh(cacheKey, key, backup);
  const body = recent ?? await job;
  return { body: body ?? fallback, maxAge: body ? 300 : 0 };
}

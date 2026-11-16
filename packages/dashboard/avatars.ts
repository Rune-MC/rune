import { avatarKey, playerName } from "./avatar-url.ts";
const fallback = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=", "base64");
const cache = new Map<string, { body: Uint8Array; expires: number }>();
const inFlight = new Map<string, Promise<Uint8Array>>();
const queued: (() => void)[] = [];
let fetching = 0;

async function fetchImage(key: string): Promise<Uint8Array> {
  const limit = 64 * 1024;
  try {
    const response = await fetch("https://minotar.net/avatar/" + key + "/40", {
      signal: AbortSignal.timeout(2500), redirect: "error", headers: { Accept: "image/png" },
    });
    if (!response.ok || response.headers.get("Content-Type")?.split(";")[0] !== "image/png" || !response.body) {
      await response.body?.cancel();
      return fallback;
    }
    const reader = response.body.getReader();
    const pieces: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > limit) { await reader.cancel(); return fallback; }
        pieces.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const image = Buffer.concat(pieces);
    return image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? image : fallback;
  } catch {
    return fallback;
  }
}

async function fetchQueued(key: string) {
  if (fetching < 8) fetching++;
  else await new Promise<void>((ready) => queued.push(ready));
  try { return await fetchImage(key); }
  finally {
    const next = queued.shift();
    if (next) next();
    else fetching--;
  }
}

async function lookup(key: string): Promise<Uint8Array> {
  const saved = cache.get(key);
  if (saved && saved.expires > Date.now()) {
    cache.delete(key);
    cache.set(key, saved);
    return saved.body;
  }
  const pending = inFlight.get(key);
  if (pending) return pending;
  if (inFlight.size >= 40) return fallback;
  const job = fetchQueued(key).then((body) => {
    cache.delete(key);
    cache.set(key, { body, expires: Date.now() + (body === fallback ? 5 : 60) * 60_000 });
    while (cache.size > 256) cache.delete(cache.keys().next().value!);
    return body;
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}

export async function avatar(value: string, name?: string) {
  const key = avatarKey(value);
  let body = key ? await lookup(key) : fallback;
  if (body === fallback && name && playerName.test(name) && name.toLowerCase() !== key) {
    body = await lookup(name.toLowerCase());
  }
  return { body, maxAge: body === fallback ? 0 : 300 };
}

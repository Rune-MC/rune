import { AuthError, type Auth } from "./index.ts";

export function getBearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  const match = header && /^Bearer ([A-Za-z0-9_.-]{1,2048})$/i.exec(header);
  return match ? match[1] : null;
}

export interface HandlerOptions {
  origin: string;
  basePath?: string;
  allowRegistration?: boolean;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new AuthError("input", "Send an application/json request.");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError("input", "A JSON body is required.");
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > 8192) {
        void reader.cancel().catch(() => {});
        throw new AuthError("size", "Request body is too large.");
      }
      parts.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  let data: unknown;
  try {
    data = JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw new AuthError("input", "Invalid JSON.");
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new AuthError("input", "A JSON object is required.");
  }
  return data as Record<string, unknown>;
}

function fields(body: Record<string, unknown>, ...keys: string[]): string[] {
  return keys.map((key) => {
    const value = body[key];
    if (typeof value !== "string") throw new AuthError("input", `Missing ${key}.`);
    return value;
  });
}

const statuses = { input: 400, credentials: 401, conflict: 409, busy: 429, origin: 403, size: 413 };

/** Fetch-style same-origin cookie handlers. Mount with your web framework. */
export function createAuthHandler(auth: Auth, { origin, basePath = "/auth", allowRegistration = false }: HandlerOptions) {
  const url = new URL(origin);
  const secure = url.protocol === "https:";
  if (url.origin !== origin || (!secure && !(url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new TypeError("origin must be an HTTPS origin, or an HTTP loopback origin for development");
  }
  if (!/^\/[a-zA-Z0-9-]+(?:\/[a-zA-Z0-9-]+)*$/.test(basePath)) throw new TypeError("invalid auth base path");
  const cookieName = secure ? "__Host-rune-auth" : "rune-auth-dev";
  const cookie = (value: string, maxAge: number) =>
    `${cookieName}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  function readCookie(request: Request) {
    const values = request.headers.get("Cookie")?.split(";").map((part) => part.trim())
      .filter((part) => part.startsWith(cookieName + "="));
    return values?.length === 1 ? values[0].slice(cookieName.length + 1) : "";
  }
  function json(data: unknown, status = 200, setCookie?: string) {
    const headers = new Headers({ "Cache-Control": "no-store" });
    if (setCookie) headers.set("Set-Cookie", setCookie);
    return Response.json(data, { status, headers });
  }
  function checkOrigin(request: Request) {
    if (request.headers.get("Origin") !== origin) throw new AuthError("origin", "Request origin denied.");
  }
  async function authenticate(request: Request) {
    return auth.authenticate(readCookie(request));
  }
  async function handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const action = path.startsWith(basePath + "/") ? path.slice(basePath.length + 1) : "";
    try {
      if (action === "me" && request.method === "GET") {
        const account = await authenticate(request);
        return account ? json({ account }) : json({ error: "Sign in first." }, 401);
      }
      if (!["register", "sign-in", "sign-out", "sign-out-everywhere", "change-password"].includes(action) ||
          (action === "register" && !allowRegistration)) return json({ error: "Not found." }, 404);
      if (request.method !== "POST") return json({ error: "Use POST." }, 405);
      checkOrigin(request);
      if (action === "sign-out") {
        await auth.signOut(readCookie(request));
        return json({ ok: true }, 200, cookie("", 0));
      }
      if (action === "sign-out-everywhere") {
        await auth.signOutEverywhere(readCookie(request));
        return json({ ok: true }, 200, cookie("", 0));
      }
      const body = await readJson(request);
      if (action === "change-password") {
        const [oldPassword, newPassword] = fields(body, "oldPassword", "newPassword");
        await auth.changePassword(readCookie(request), oldPassword, newPassword);
        return json({ ok: true }, 200, cookie("", 0));
      }
      const [login, password] = fields(body, "login", "password");
      if (action === "register") return json({ account: await auth.register(login, password) }, 201);
      const signedIn = await auth.signIn(login, password);
      const maxAge = Math.max(0, Math.floor((signedIn.expiresAt - Date.now()) / 1000));
      return json({ account: signedIn.account }, 200, cookie(signedIn.token, maxAge));
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      return json({ error: error.message }, statuses[error.code]);
    }
  }
  return { handle, authenticate, checkOrigin };
}

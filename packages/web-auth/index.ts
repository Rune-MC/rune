import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { record, type RecordStore, type StoredRecord } from "@rune/storage";

export type AuthStore = RecordStore;

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^scrypt17\$([a-f0-9]{32})\$([a-f0-9]{64})$/;
const DUMMY_HASH = "scrypt17$" + "0".repeat(32) + "$" + "0".repeat(64);
const randomToken = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export interface Account { id: string; login: string }
interface StoredAccount extends Account { passwordHash: string; authVersion: string }
interface Grant { login: string; userId: string; authVersion: string }

export type AuthMode =
  | { mode: "session" }
  | { mode: "jwt"; key: Uint8Array; issuer: string; audience: string };

export interface AuthOptions {
  store: AuthStore;
  credentials: AuthMode;
  ttlSeconds?: number;
  namespace?: string;
  maxPasswordJobs?: number;
  /** Optional shared limiter for deployments with multiple host processes. */
  allowAttempt?: (key: string) => boolean | Promise<boolean>;
}

export class AuthError extends Error {
  readonly code: "input" | "credentials" | "conflict" | "busy" | "origin" | "size";
  constructor(code: AuthError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

function normalizeLogin(value: unknown): string {
  const login = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9._+@-]{2,159}$/.test(login)) {
    throw new AuthError("input", "Use a username or email of 3 to 160 ASCII characters.");
  }
  return login;
}

function passwordBytes(value: unknown, newPassword = false): Buffer {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value) > 1024 ||
      (newPassword && [...value].length < 15)) {
    throw new AuthError("input", "Use a password of at least 15 characters and at most 1024 bytes.");
  }
  return Buffer.from(value);
}

function derive(password: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 160 * 1024 * 1024 },
      (error, key) => error ? reject(error) : resolve(key));
  });
}

async function hashPassword(password: Buffer) {
  const salt = randomBytes(16);
  return `scrypt17$${salt.toString("hex")}$${(await derive(password, salt)).toString("hex")}`;
}

async function checkPassword(password: Buffer, encoded: string) {
  const hash = HASH.exec(encoded);
  if (!hash) return false;
  return timingSafeEqual(await derive(password, Buffer.from(hash[1], "hex")), Buffer.from(hash[2], "hex"));
}

export function createAuth(options: AuthOptions) {
  const { store, credentials, namespace = "default", maxPasswordJobs = 2 } = options;
  const ttl = options.ttlSeconds ?? (credentials.mode === "jwt" ? 900 : 86_400);
  if (!/^[a-z0-9-]{1,40}$/.test(namespace)) throw new RangeError("invalid auth namespace");
  if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 2_592_000) throw new RangeError("invalid credential lifetime");
  if (!Number.isSafeInteger(maxPasswordJobs) || maxPasswordJobs < 1 || maxPasswordJobs > 8) {
    throw new RangeError("maxPasswordJobs must be between 1 and 8");
  }
  if (credentials.mode === "jwt" && (credentials.key.length < 32 || !credentials.issuer || !credentials.audience)) {
    throw new TypeError("JWT requires a random key of at least 32 bytes, an issuer, and an audience");
  }

  const accountKey = (login: string) => `${namespace}:account:${digest(login)}`;
  const grantKey = (id: string) => `${namespace}:grant:${digest(id)}`;
  const resetKey = (id: string) => `${namespace}:reset:${digest(id)}`;
  let passwordJobs = 0;
  const attempts = new Map<string, { expires: number; count: number }>();
  async function limit(key: string) {
    const now = Date.now();
    let entry = attempts.get(key);
    if (entry && entry.expires <= now) {
      attempts.delete(key);
      entry = undefined;
    }
    if (!entry && attempts.size >= 20_000) {
      for (const [name, value] of attempts) if (value.expires <= now) attempts.delete(name);
      if (attempts.size >= 20_000) throw new AuthError("busy", "Try again later.");
    }
    if (!entry) {
      entry = { expires: now + 60_000, count: 0 };
      attempts.set(key, entry);
    }
    if (++entry.count > 6 || (options.allowAttempt && !(await options.allowAttempt(`${namespace}:${key}`)))) {
      throw new AuthError("busy", "Try again later.");
    }
  }
  async function passwordWork<T>(fn: () => Promise<T>): Promise<T> {
    if (passwordJobs >= maxPasswordJobs) throw new AuthError("busy", "Try again later.");
    passwordJobs++;
    try { return await fn(); } finally { passwordJobs--; }
  }
  const publicAccount = ({ id, login }: StoredAccount): Account => ({ id, login });

  async function account(login: string): Promise<{ row: StoredRecord; user: StoredAccount } | null> {
    const row = await store.get(accountKey(login));
    return row ? { row, user: JSON.parse(row.value) as StoredAccount } : null;
  }
  async function liveGrant(key: string) {
    const row = await store.get(key);
    return row?.expiresAt !== null && row?.expiresAt !== undefined && row.expiresAt > Date.now()
      ? { row, grant: JSON.parse(row.value) as Grant }
      : null;
  }
  const grantFor = (user: StoredAccount): Grant => ({ userId: user.id, login: user.login, authVersion: user.authVersion });
  const sameAccount = (grant: Grant, user: StoredAccount) =>
    grant.userId === user.id && grant.authVersion === user.authVersion;

  async function issue(user: StoredAccount) {
    const id = randomToken();
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = (issuedAt + ttl) * 1000;
    let token = id;
    if (credentials.mode === "jwt") {
      token = await new SignJWT({})
        .setProtectedHeader({ alg: "HS256", typ: "rune-auth+jwt" })
        .setIssuer(credentials.issuer).setAudience(credentials.audience)
        .setSubject(user.id).setJti(id).setIssuedAt(issuedAt).setExpirationTime(issuedAt + ttl)
        .sign(credentials.key);
    }
    if (!(await store.insert(grantKey(id), record(grantFor(user), expiresAt)))) {
      throw new Error("credential collision");
    }
    return { token, expiresAt, account: publicAccount(user) };
  }

  async function presented(token: string) {
    if (!token || token.length > 2048) return null;
    if (credentials.mode === "session") return TOKEN.test(token) ? { id: token, subject: null } : null;
    try {
      const { payload } = await jwtVerify(token, credentials.key, {
        algorithms: ["HS256"], typ: "rune-auth+jwt",
        issuer: credentials.issuer, audience: credentials.audience,
        requiredClaims: ["sub", "jti", "iat", "exp"], maxTokenAge: ttl,
      });
      return payload.jti && TOKEN.test(payload.jti) && payload.sub
        ? { id: payload.jti, subject: payload.sub }
        : null;
    } catch { return null; }
  }
  async function active(token: string) {
    const credential = await presented(token);
    if (!credential) return null;
    const key = grantKey(credential.id);
    const existing = await liveGrant(key);
    if (!existing || (credential.subject && credential.subject !== existing.grant.userId)) return null;
    const current = await account(existing.grant.login);
    return current && sameAccount(existing.grant, current.user)
      ? { current, key, grantRow: existing.row }
      : null;
  }
  async function rotate(login: string, revision: string, user: StoredAccount, changes: Partial<StoredAccount> = {}) {
    if (!(await store.replace(accountKey(login), revision, record({ ...user, ...changes, authVersion: randomToken() })))) {
      throw new AuthError("conflict", "The account changed. Please retry.");
    }
  }

  return {
    async register(identifier: string, password: string): Promise<Account> {
      const login = normalizeLogin(identifier);
      const bytes = passwordBytes(password, true);
      await limit("register:" + digest(login));
      return passwordWork(async () => {
        const user = { id: randomToken(), login, passwordHash: await hashPassword(bytes), authVersion: randomToken() };
        if (!(await store.insert(accountKey(login), record(user)))) {
          throw new AuthError("conflict", "That account already exists.");
        }
        return publicAccount(user);
      });
    },
    async signIn(identifier: string, password: string) {
      const login = normalizeLogin(identifier);
      const bytes = passwordBytes(password);
      await limit("login:" + digest(login));
      const current = await account(login);
      const valid = await passwordWork(() => checkPassword(bytes, current?.user.passwordHash ?? DUMMY_HASH));
      if (!current || !valid) throw new AuthError("credentials", "Invalid sign-in.");
      return issue(current.user);
    },
    async authenticate(token: string): Promise<Account | null> {
      const value = await active(token);
      return value ? publicAccount(value.current.user) : null;
    },
    async signOut(token: string) {
      const value = await active(token);
      return value ? store.remove(value.key, value.grantRow.revision) : false;
    },
    async signOutEverywhere(token: string) {
      const value = await active(token);
      if (!value) throw new AuthError("credentials", "Sign in first.");
      await rotate(value.current.user.login, value.current.row.revision, value.current.user);
    },
    async changePassword(token: string, oldPassword: string, newPassword: string) {
      const value = await active(token);
      if (!value) throw new AuthError("credentials", "Sign in first.");
      const before = passwordBytes(oldPassword);
      const after = passwordBytes(newPassword, true);
      await limit("password:" + value.current.user.id);
      const passwordHash = await passwordWork(async () => {
        if (!(await checkPassword(before, value.current.user.passwordHash))) {
          throw new AuthError("credentials", "Incorrect current password.");
        }
        return hashPassword(after);
      });
      await rotate(value.current.user.login, value.current.row.revision, value.current.user, { passwordHash });
    },
    /** Server-only. Deliver the return value through a verified recovery channel. */
    async createResetCode(identifier: string) {
      const login = normalizeLogin(identifier);
      await limit("reset:" + digest(login));
      const current = await account(login);
      if (!current) return null;
      const code = randomToken();
      if (!(await store.insert(resetKey(code), record(grantFor(current.user), Date.now() + 900_000)))) {
        throw new Error("recovery code collision");
      }
      return code;
    },
    async resetPassword(code: string, newPassword: string) {
      if (!TOKEN.test(code)) throw new AuthError("credentials", "Invalid or expired recovery code.");
      const bytes = passwordBytes(newPassword, true);
      const key = resetKey(code);
      const existing = await liveGrant(key);
      if (!existing) throw new AuthError("credentials", "Invalid or expired recovery code.");
      const current = await account(existing.grant.login);
      if (!current || !sameAccount(existing.grant, current.user)) {
        throw new AuthError("credentials", "Invalid or expired recovery code.");
      }
      const passwordHash = await passwordWork(() => hashPassword(bytes));
      if (!(await store.remove(key, existing.row.revision))) {
        throw new AuthError("credentials", "Invalid or expired recovery code.");
      }
      await rotate(current.user.login, current.row.revision, current.user, { passwordHash });
    },
    pruneExpired: () => store.prune(),
  };
}

export type Auth = ReturnType<typeof createAuth>;
export { createAuthHandler, getBearerToken } from "./web.ts";

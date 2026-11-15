import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { connect } from "@rune/sqlite";
import { createAuth, createAuthHandler } from "@rune/web-auth";

const password = "Some sufficiently long test passphrase 123!";
const replacement = "Another sufficiently long test passphrase.";

test("SQLite-backed login, rotation, and one-use recovery", async () => {
  const db = await connect(":memory:");
  try {
    const auth = createAuth({ store: db.store, credentials: { mode: "session" } });
    const person = await auth.register("Visitor@example.com", password);
    assert.deepEqual(Object.keys(person).sort(), ["id", "login"]);
    assert.equal(person.login, "visitor@example.com");
    await assert.rejects(auth.signIn(person.login, "wrong password"), { code: "credentials" });
    const session = await auth.signIn(person.login, password);
    assert.deepEqual(await auth.authenticate(session.token), person);
    const reset = await auth.createResetCode(person.login);
    assert.ok(reset);
    const results = await Promise.allSettled([
      auth.resetPassword(reset, replacement),
      auth.resetPassword(reset, replacement),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(await auth.authenticate(session.token), null);
    const newSession = await auth.signIn(person.login, replacement);
    assert.equal(await auth.signOut(newSession.token), true);
    assert.equal(await auth.authenticate(newSession.token), null);
  } finally { await db.close(); }
});

test("JWT issuer and audience enforcement, token integrity, and browser origin guards", async () => {
  const db = await connect(":memory:");
  try {
    const credentials = { mode: "jwt", key: randomBytes(32), issuer: "urn:paper-test", audience: "web" } as const;
    const auth = createAuth({ store: db.store, credentials });
    const wrongAudience = createAuth({ store: db.store, credentials: { ...credentials, audience: "other" } });
    const origin = "https://test.example";
    const handler = createAuthHandler(auth, { origin, allowRegistration: true });
    const body = JSON.stringify({ login: "player", password });
    const request = (path: string, sender = origin, cookie?: string) =>
      new Request(origin + path, { method: "POST", body, headers: {
        Origin: sender, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}),
      } });
    assert.equal((await handler.handle(request("/auth/register", "https://other.example"))).status, 403);
    assert.equal((await handler.handle(request("/auth/register"))).status, 201);
    const signedIn = await handler.handle(request("/auth/sign-in"));
    assert.equal(signedIn.status, 200);
    const cookie = signedIn.headers.get("Set-Cookie")!;
    assert.match(cookie, /^__Host-rune-auth=/);
    assert.match(cookie, /; HttpOnly; SameSite=Lax; Secure$/);
    const parts = cookie.split(";")[0];
    const token = parts.slice(parts.indexOf("=") + 1);
    assert.equal((await auth.authenticate(token))?.login, "player");
    assert.equal(await wrongAudience.authenticate(token), null);
    assert.equal(await auth.authenticate("a" + token), null);
    await handler.handle(request("/auth/sign-out-everywhere", origin, parts));
    assert.equal(await auth.authenticate(token), null);
  } finally { await db.close(); }
});

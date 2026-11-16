# @rune/web-auth

TypeScript authentication for web apps. Use opaque database-backed sessions
or signed, revocable JWTs. Both modes support sign-out, sign-out everywhere,
password changes, and one-time password recovery. A custom `AuthStore` can
add any backend that supports atomic insert and compare-and-swap operations.

## Install

```sh
rune add @rune/web-auth
rune add @rune/sqlite
```

The second command installs the adapter used below. Run the library on
the server side of a TypeScript Rune with a Fetch-compatible HTTP handler.

## SQLite and sessions

```typescript
import { connect } from "@rune/sqlite";
import { createAuth, createAuthHandler } from "@rune/web-auth";

const db = await connect("./auth.sqlite");
const auth = createAuth({
  store: db.store,
  credentials: { mode: "session" },
});
const routes = createAuthHandler(auth, { origin: "https://app.example.com" });
// Mount routes.handle(request) under /auth/* in your HTTP server.
// Use await routes.authenticate(request) in authenticated routes.
```

Install the adapter you need using `rune add @rune/sqlite` or one of the
packages below. Use SQLite on a persistent disk. Call `db.close()` on shutdown.

| Storage | Rune |
| --- | --- |
| MongoDB | `@rune/mongo` |
| MySQL or MariaDB | `@rune/mysql` |
| PostgreSQL | `@rune/postgres` |
| Redis 6.2+ | `@rune/redis` |
| SQLite file | `@rune/sqlite` |
| Tests | `memoryStore()` from `@rune/storage` |

Each adapter offers `connect` and can also wrap an initialized client. Use the
same auth namespace and database in every instance of an app. Isolate different
apps with separate namespaces or tables. Call `auth.pruneExpired()` periodically
for SQL stores. Redis expires its keys and MongoDB uses a TTL index.

## JWTs

Pass `credentials: { mode: "jwt", key, issuer, audience }` to `createAuth`.
Use a randomly generated key of at least 32 bytes from your secret manager,
with explicit issuer and audience values for the app. JWT verification pins
the algorithm and checks the issuer, audience, token type, and expiration.
JWTs use a store lookup so individual sign-out can revoke them immediately.
The default lifetime is 15 minutes for JWTs and one day for opaque sessions.

For a bearer API, call `auth.signIn(login, password)` in your own handler and
pass `getBearerToken(request)` to `auth.authenticate` when a token is present.
The built-in browser handler puts the credential in an HttpOnly cookie.

## Routes and account recovery

| Route | Behavior |
| --- | --- |
| `GET /auth/me` | Show the signed-in account |
| `POST /auth/sign-in` | Accept JSON `{ login, password }` and set the cookie |
| `POST /auth/register` | Accept the same fields when `allowRegistration` is enabled |
| `POST /auth/sign-out` | Revoke this credential and clear its cookie |
| `POST /auth/sign-out-everywhere` | Revoke all credentials for the current account |
| `POST /auth/change-password` | Accept `{ oldPassword, newPassword }` and revoke prior credentials |

Mutating built-in routes verify the request origin. Call
`routes.checkOrigin(request)` in your own cookie-authenticated mutations.
For recovery, call `createResetCode(login)` on the server and deliver it through
a verified recovery channel. Keep the code out of API responses and logs.
`resetPassword(code, password)` consumes the code once and revokes prior
credentials.

Custom account storage adapters can use `normalizeLogin(login)` and
`authAccountKey(namespace, login)` to match Web Auth's account keys.
`revokeAccountSessions(record)` prepares a replacement credential record
with a fresh session version. Commit it with a revision check alongside
an administrative change such as disabling an account.

The library hashes passwords with scrypt and limits concurrent password work.
Use an ingress rate limit as well. For multiple instances pass a shared
`allowAttempt` limiter. Registration, identity verification, authorization
rules, and recovery delivery are controlled by your application.

## Application integration

- Provision users with `auth.register(login, password)` or enable the
  registration route with `allowRegistration: true` after wiring your
  application's registration policy. Logins are normalized to lowercase.
  New passwords require at least 15 characters and may use up to 1024 bytes.
- In protected routes, use the authenticated account's stable `id` for
  authorization. `authenticate` returns `null` for an invalid or absent
  credential. Store roles and application profile data separately.
- Deploy browser routes over HTTPS and set `origin` to the public site origin.
  Change `basePath` if you mount the handler under a path other than `/auth`.
- `createAuth` also accepts `ttlSeconds`, `namespace`, `maxPasswordJobs`,
  and `allowAttempt`. Handle credentials and recovery codes on the server.

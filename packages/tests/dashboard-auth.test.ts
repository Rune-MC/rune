import assert from "node:assert/strict";
import test from "node:test";
import { memoryStore } from "@rune/storage";
import { createDashboardAuth } from "../dashboard/auth.ts";

test("exactly one concurrent signup becomes the durable dashboard owner", async () => {
  const storage = memoryStore();
  const origin = "http://127.0.0.1:8777";
  const dashboard = createDashboardAuth(() => storage);
  const auth = dashboard.handlers(origin);
  const password = "generated testing password";
  const request = (endpoint: string, login: string) => new Request(origin + "/auth/" + endpoint, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ login, password }),
  });
  assert.equal(await dashboard.hasOwner(), false);
  const candidates = ["first-owner", "second-owner"];
  const results = await Promise.all(candidates.map((login) => auth.handle(request("register", login))));
  assert.deepEqual(results.map((response) => response.status).sort(), [201, 409]);
  const owner = candidates[results.findIndex((response) => response.status === 201)];
  const restored = createDashboardAuth(() => storage);
  assert.equal(await restored.hasOwner(), true);
  const session = await restored.handlers(origin).handle(request("sign-in", owner));
  assert.equal(session.status, 200);
  assert.match(session.headers.get("set-cookie") ?? "", /HttpOnly/);
  const other = candidates.find((candidate) => candidate !== owner)!;
  assert.equal((await restored.handlers(origin).handle(request("sign-in", other))).status, 401);
});

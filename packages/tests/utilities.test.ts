import assert from "node:assert/strict";
import { test } from "node:test";
import { createCooldowns } from "@rune/cooldowns";
import { createRateLimiter } from "@rune/rate-limit";
import { numberedLines, paginate } from "@rune/pagination";
import { WindowDetector } from "../anticheat/detector.ts";
import { reachable, rulesFor, type Group } from "../permissions/model.ts";

test("cooldowns and rate limits refill without exceeding the key budget", () => {
  let now = 0;
  const clock = () => now;
  const cooldown = createCooldowns({ maxKeys: 1, clock });
  assert.equal(cooldown.tryStart("a", 30).allowed, true);
  assert.deepEqual(cooldown.tryStart("a", 100), { allowed: false, retryAfterMs: 30, reason: "cooldown" });
  assert.deepEqual(cooldown.tryStart("b", 100), { allowed: false, retryAfterMs: 0, reason: "capacity" });
  now = 30;
  assert.equal(cooldown.tryStart("b", 100).allowed, true);

  const budget = createRateLimiter({ capacity: 2, intervalMs: 100, clock });
  assert.equal(budget.consume("a", 2).allowed, true);
  assert.equal(budget.consume("a").retryAfterMs, 50);
  now += 50;
  assert.equal(budget.consume("a").allowed, true);
});

test("paging clamps and keeps global item numbers", () => {
  const page = paginate(["a", "b", "c", "d"], { page: 10, pageSize: 3 });
  assert.equal(page.page, 2);
  assert.equal(page.next, null);
  assert.deepEqual(numberedLines(page), ["4. d"]);
  assert.deepEqual(paginate([]).items, []);
});

test("group inheritance terminates and denies beat grants", () => {
  const groups = new Map<string, Group>([
    ["default", { parents: [], rules: { "example.read": true } }],
    ["staff", { parents: ["team"], rules: { "example.edit": true } }],
    ["team", { parents: ["staff"], rules: { "example.edit": false } }],
  ]);
  assert.equal(reachable(groups, ["staff"]).size, 2);
  assert.equal(rulesFor(groups, ["staff"]).get("example.edit"), false);
  assert.equal(rulesFor(groups, ["staff"]).get("example.read"), true);
});

test("anticheat reports sustained windows and clears on discontinuity", () => {
  const engine = new WindowDetector();
  assert.equal(engine.sample("a", 20, 0, 10), null);
  assert.equal(engine.sample("a", 20, 1000, 10), null);
  assert.deepEqual(engine.sample("a", 20, 2000, 10), { rate: 20, consecutive: 2 });
  assert.equal(engine.sample("a", 20, 6000, 10), null);
  engine.clear("a");
  assert.equal(engine.sample("a", 20, 7000, 10), null);
});

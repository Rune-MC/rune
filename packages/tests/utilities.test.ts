import assert from "node:assert/strict";
import { test } from "node:test";
import { createCooldowns } from "@rune/cooldowns";
import { createRateLimiter } from "@rune/rate-limit";
import { numberedLines, paginate } from "@rune/pagination";
import { WindowDetector } from "../anticheat/detector.ts";
import { reachable, rulesFor, type Group } from "../permissions/model.ts";
import { nextExpiration, resolveProfile } from "../permissions/resolve.ts";

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

test("permissions preserve legacy memberships and resolve scoped ranks, labels, and expiry", () => {
  const data = {
    groups: {
      default: { parents: [], rules: { "build.place": false } },
      builder: {
        parents: [], rules: { "build.*": true }, weight: 5,
        profile: { prefix: [{ text: "<green>Builder</green>", priority: 25 }] },
      },
      vip: {
        parents: ["builder"], rules: {}, weight: 10,
        profile: {
          prefix: [{ text: "<gold>VIP</gold>", priority: 50 }],
          suffix: [{ text: "Hub", priority: 1, context: { world: "hub" } }],
        },
      },
    },
    members: { alex: ["builder"] },
    players: {
      alex: {
        grants: [{ group: "vip", context: { server: "survival" }, expiresAt: 2000 }],
        rules: [{ node: "build.place", allow: true, context: { world: "hub" }, expiresAt: 1500 }],
      },
    },
  };
  const before = resolveProfile(data, "alex", { server: "survival", world: "hub" }, 1000);
  assert.equal(before.explain("build.place")?.allowed, true);
  assert.equal(before.explain("build.place")?.source, "player");
  assert.equal(before.primary, "vip");
  assert.deepEqual(before.style("prefix", true), ["<gold>VIP</gold>", "<green>Builder</green>"]);
  assert.deepEqual(before.style("suffix"), ["Hub"]);
  assert.equal(nextExpiration(data, 1000), 1500);
  assert.equal(resolveProfile(data, "alex", { server: "survival", world: "hub" }, 1600).explain("build.place")?.allowed, false);
  const after = resolveProfile(data, "alex", { server: "survival", world: "hub" }, 2500);
  assert.equal(after.primary, "builder");
  assert.deepEqual(after.style("prefix"), ["<green>Builder</green>"]);
  assert.deepEqual(after.style("suffix"), []);
  assert.equal(after.exactRules(["build.break"]).get("build.break"), true);
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

import assert from "node:assert/strict";
import { test } from "node:test";
import { expiry } from "../moderation/duration.ts";
import { active, editReport, initial, recordCase, recordReport, revokeCase } from "../moderation/model.ts";

test("moderation parses compact seconds, minutes, months, years and mixed durations", () => {
  const start = Date.UTC(2024, 0, 31, 12);
  assert.equal(expiry("1s", start), start + 1_000);
  assert.equal(expiry("1m", start), start + 60_000);
  assert.equal(expiry("1mo 2d", start), Date.UTC(2024, 2, 2, 12));
  assert.equal(expiry("1y", Date.UTC(2024, 1, 29)), Date.UTC(2025, 1, 28));
  assert.equal(expiry("1h30m", start), start + 5_400_000);
  assert.equal(expiry("permanent", start), undefined);
  for (const input of ["1", "0s", "-1m", "1mm", "1m2m", "101y", "1ms"]) assert.throws(() => expiry(input, start), Error);
});

test("timed sanctions become inactive on expiry or revocation and keep their original case", () => {
  const data = initial();
  const target = { id: "player", name: "Player" };
  const actor = { id: "staff", name: "Staff" };
  const input = { kind: "mute" as const, target, actor, reason: "Spam", at: 1_000, expiresAt: 2_000 };
  const first = recordCase(data, input);
  assert.ok(active(first, 1_999));
  assert.equal(active(first, 2_000), false);
  assert.throws(() => recordCase(data, input), /already active/);
  revokeCase(data, first.id, { actor, at: 1_500, reason: "Reviewed" });
  assert.equal(active(first, 1_500), false);
  const second = recordCase(data, { ...input, at: 1_600, expiresAt: undefined });
  assert.equal(second.id, 2);
  assert.equal(first.reason, "Spam");
  assert.equal(first.revoked?.reason, "Reviewed");
});

test("report assignment, resolution and reopening reject conflicting actions", () => {
  const data = initial();
  const reporter = { id: "one", name: "One" };
  const target = { id: "two", name: "Two" };
  const actor = { id: "staff", name: "Staff" };
  const input = { reporter, target, reason: "Spam", at: 1 };
  const item = recordReport(data, input);
  assert.throws(() => recordReport(data, input), /already have an open report/);
  editReport(data, item.id, actor, "claim", 2);
  assert.throws(() => editReport(data, item.id, actor, "claim", 3), /assigned/);
  editReport(data, item.id, actor, "resolve", 4, "Handled");
  assert.equal(item.resolved?.reason, "Handled");
  editReport(data, item.id, actor, "reopen", 5);
  assert.equal(item.assigned, undefined);
  assert.equal(item.resolved, undefined);
});

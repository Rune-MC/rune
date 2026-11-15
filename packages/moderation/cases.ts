import { tell, uuid } from "@rune/paper-ui";
import { expiry, remaining } from "./duration.ts";
import { active, caseStatus, details, fail, isTimed, recordCase, revokeCase, type Case, type Identity, type Kind } from "./model.ts";
import { actor, backend, banFor, can, immune, ipAddress, isConsole, online, playerIp, requirePermission } from "./platform.ts";

export type Done = (message: string) => void;
export function feedback(sender: CommandSender) {
  return {
    done: (message: string) => tell(sender, message, "green"),
    reject: (message: string) => tell(sender, message, "red"),
  };
}

export function informStaff(message: string) {
  console.info(message);
  for (const player of rune.players()) if (can(player, "notify")) tell(player, message, "gold");
}

export function playerNotice(item: Case) {
  const label = { ban: "Banned", ipban: "Banned", mute: "Muted", freeze: "Frozen", kick: "Kicked", warn: "Warning", note: "Note" }[item.kind];
  return `${label} • Case #${item.id}\n${item.reason}${isTimed(item.kind) ? "\nDuration remaining: " + remaining(item.expiresAt) : ""}`;
}

export function displayTarget(sender: CommandSender, item: Case) {
  return item.kind === "ipban" && !can(sender, "ipban") ? "IP address (restricted)" : item.target.name;
}

export function describeCase(sender: CommandSender, row: Case) {
  return `#${row.id} ${row.kind.toUpperCase()} • ${displayTarget(sender, row)} • ${caseStatus(row)} • ${row.reason}`;
}

function protect(sender: CommandSender, target: Identity, byIp: boolean) {
  if (isConsole(sender)) return;
  if (target.id === actor(sender).id) fail("Choose a target other than yourself.");
  if (byIp) {
    const affected = rune.players().filter((p) => playerIp(p) === target.id);
    if (affected.some((p) => p.equals(sender) || immune({ id: uuid(p), name: p.getName() }))) {
      fail("That address matches you or an immune player. Use the server console if this is intended.");
    }
  } else if (immune(target)) fail("That player is immune to staff actions. Only the console can override this.");
}

export function issue(sender: CommandSender, kind: Kind, target: Identity, reason: string, duration: string,
  done = feedback(sender).done, reject = feedback(sender).reject) {
  requirePermission(sender, kind);
  if (kind === "ipban") {
    const ip = ipAddress(target.id);
    target = { id: ip, name: ip };
  }
  protect(sender, target, kind === "ipban");
  if (kind === "kick" && !online(target.id)) fail("That player must be online to kick.");
  const at = Date.now();
  const input = { kind, target, reason: details(reason), actor: actor(sender), at, expiresAt: isTimed(kind) ? expiry(duration, at) : undefined };
  backend.edit((state) => recordCase(state, input), (item) => {
    const player = kind === "ipban" ? undefined : online(item.target.id);
    if (player) {
      if (kind === "kick") player.kick(rune.adventure.text(playerNotice(item)));
      else if (kind !== "note" && kind !== "ban") tell(player, playerNotice(item), "red");
    }
    informStaff(`[Moderation] ${item.actor.name} recorded ${item.kind} case #${item.id} for ${kind === "ipban" ? "an IP address" : target.name}.`);
    void rune.events.emit("moderation.case.created", item);
    done(describeCase(sender, item));
  }, reject);
}

export function undo(sender: CommandSender, id: number, reason: string, done = feedback(sender).done, reject = feedback(sender).reject) {
  const current = backend.value().cases.find((entry) => entry.id === id);
  if (!current) return fail("Case not found.");
  requirePermission(sender, current.kind);
  requirePermission(sender, "revoke");
  const review = { actor: actor(sender), at: Date.now(), reason: details(reason) };
  backend.edit((state) => revokeCase(state, id, review), (item) => {
    informStaff(`[Moderation] ${review.actor.name} revoked case #${id}.`);
    void rune.events.emit("moderation.case.revoked", item);
    done(`Revoked case #${id}.`);
  }, reject);
}

export function activeId(kind: Kind, id: string) {
  return backend.value().cases.find((entry) => entry.kind === kind && entry.target.id === id && active(entry))?.id ??
    fail("There is no matching active punishment.");
}

// Also apply bans committed by another server once the shared snapshot updates.
backend.onChange(() => {
  for (const player of rune.players()) {
    try {
      const item = banFor(uuid(player), playerIp(player));
      if (item) player.kick(rune.adventure.text(playerNotice(item)));
    } catch (error) { console.warn("Could not apply moderation kick to " + player.getName(), error); }
  }
});

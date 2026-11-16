import { isIP } from "node:net";
import { tell } from "@rune/paper-ui";
import { active, fail, type TimedKind } from "../model.ts";
import { backend, can, directory, ipAddress, online, person, playerIp } from "../platform.ts";

export const playerNames = () => directory().map(({ name }) => name);
export const searchablePlayers = (permission: string, onlineOnly = false) =>
  (_partial: string, { sender }: CommandSuggestionContext) => {
    if (!can(sender, permission)) return [];
    return onlineOnly ? rune.players().map((player) => player.getName()) : playerNames();
  };
export const durationPresets = ["30s", "1m", "5m", "15m", "1h", "1h30m", "1d", "1w", "1mo", "1y", "permanent"];
export const slowModePresets = ["0", "2", "5", "10", "30", "60", "120", "300", "600"];
export const positiveId = { type: "int", min: 1 } as const;
export const pageArg = (count: (context: CommandSuggestionContext) => number) => ({
  ...positiveId, optional: true,
  suggest: (_partial: string, context: CommandSuggestionContext) =>
    Array.from({ length: Math.min(256, Math.max(1, Math.ceil(count(context) / 8))) }, (_, index) => String(index + 1)),
});

export const caseIds = (revocable = false) => (_partial: string, { sender }: CommandSuggestionContext) =>
  backend.value().cases.slice().reverse().filter((item) =>
    !revocable || (can(sender, "revoke") && can(sender, item.kind) && !item.revoked &&
      (item.expiresAt === undefined || active(item))))
    .map(({ id }) => String(id));

export const activeTargets = (kind: TimedKind) => (_partial: string, { sender }: CommandSuggestionContext) => {
  if (!can(sender, "revoke") || !can(sender, kind)) return [];
  const matches = backend.value().cases.filter((item) => item.kind === kind && active(item));
  if (kind === "ipban") return matches.map((item) => item.target.id);
  const names = new Map(directory().map(({ id, name }) => [id, name]));
  return matches.map((item) => names.get(item.target.id) ?? item.target.id);
};

export const punishmentReasons = ["Harassment", "Spam", "Cheating", "Griefing", "Staff review"];
export const revokeReasons = ["Appeal accepted", "Staff review completed", "Issued in error"];

export function run(sender: CommandSender, action: () => void) {
  try { action(); }
  catch (error) { tell(sender, error instanceof Error ? error.message : "Moderation action failed.", "red"); }
}

export function inGame(sender: CommandCtx["sender"]) {
  if (!sender.isPlayer) fail("Use this command in game.");
  return sender as unknown as Player;
}

export function address(input: string, allowPlayer = false) {
  const value = input.trim();
  const candidate = allowPlayer && !isIP(value) ? online(person(value).id) : undefined;
  const key = candidate ? playerIp(candidate) ?? fail("That player's IP address is unavailable.") : ipAddress(value);
  return { id: key, name: key };
}

export function printPage(sender: CommandSender, title: string, rows: readonly string[], requested = 1) {
  const pages = Math.max(1, Math.ceil(rows.length / 8));
  const page = Math.max(1, Math.min(requested, pages));
  tell(sender, `${title} • Page ${page}/${pages} • ${rows.length} entries`);
  if (!rows.length) tell(sender, "No results.", "gray");
  for (const row of rows.slice((page - 1) * 8, page * 8)) tell(sender, row, "gray");
}

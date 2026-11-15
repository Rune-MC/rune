import { tell } from "@rune/paper-ui";
import { fail } from "../model.ts";
import { ipAddress } from "../platform.ts";

export const playerNames = () => rune.players().map((player) => player.getName());
export const durationPresets = ["30s", "5m", "1h", "1d", "1w", "1mo", "1y", "permanent"];
export const positiveId = { type: "int", min: 1 } as const;
export const pageArg = { ...positiveId, optional: true } as const;

export function run(sender: CommandSender, action: () => void) {
  try { action(); }
  catch (error) { tell(sender, error instanceof Error ? error.message : "Moderation action failed.", "red"); }
}

export function inGame(sender: CommandCtx["sender"]) {
  if (!sender.isPlayer) fail("Use this command in game.");
  return sender as unknown as Player;
}

export function address(input: string) {
  const key = ipAddress(input);
  return { id: key, name: key };
}

export function printPage(sender: CommandSender, title: string, rows: readonly string[], requested = 1) {
  const pages = Math.max(1, Math.ceil(rows.length / 8));
  const page = Math.max(1, Math.min(requested, pages));
  tell(sender, `${title} • Page ${page}/${pages} • ${rows.length} entries`);
  if (!rows.length) tell(sender, "No results.", "gray");
  for (const row of rows.slice((page - 1) * 8, page * 8)) tell(sender, row, "gray");
}

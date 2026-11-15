import { normalizePositionName, snapshot, teleportTo, type Position } from "@rune/positions";
import { paperRecords, StorageInputError } from "@rune/storage";

interface Warp { point: Position; restricted: boolean }
const warps = paperRecords<Warp>(rune, "warps", "rune-warps");
const canVisit = (sender: CommandCtx["sender"], name: string, warp: Warp) =>
  !warp.restricted || sender.isOp() || sender.hasPermission("rune.warp." + name);

function warpName(ctx: CommandCtx, input: string) {
  const name = normalizePositionName(input);
  if (!name) ctx.sender.sendMessage("Use 1–24 letters, digits, underscores, or hyphens.");
  return name;
}

@Command("warp", { description: "Visit or list server warps" })
export class VisitWarp {
  @Arg("destination", { type: "word", optional: true }) destination?: string;
  @Run
  run(ctx: CommandCtx) {
    if (this.destination == null) {
      const available = Object.entries(warps.value()).filter(([name, warp]) => canVisit(ctx.sender, name, warp))
        .map(([name]) => name).sort();
      ctx.sender.sendMessage(available.length ? "Warps: " + available.join(", ") : "No warps are available.");
      return;
    }
    if (!ctx.sender.isPlayer) { ctx.sender.sendMessage("Run this command in game."); return; }
    const name = warpName(ctx, this.destination);
    if (!name) return;
    const data = warps.value();
    const warp = Object.hasOwn(data, name) ? data[name] : undefined;
    if (!warp || !canVisit(ctx.sender, name, warp)) { ctx.sender.sendMessage("Warp unavailable."); return; }
    if (!teleportTo(ctx.sender as unknown as Player, warp.point).ok) ctx.sender.sendMessage("Could not teleport.");
  }
}

@Command("warp set", { permission: "rune.admin" })
export class SaveWarp {
  @Arg("name", { type: "word" }) name!: string;
  @Arg("restricted", { type: "bool", optional: true }) restricted?: boolean;
  @Run run(ctx: CommandCtx) {
      if (!ctx.sender.isPlayer) { ctx.sender.sendMessage("Stand at the warp in game."); return; }
      const name = warpName(ctx, this.name);
      if (!name) return;
      const player = ctx.sender as unknown as Player;
      const point = snapshot(player.getLocation());
      warps.edit((data) => {
        const restricted = this.restricted ?? data[name]?.restricted ?? false;
        data[name] = { point, restricted };
        return restricted;
      }, (restricted) => ctx.sender.sendMessage(`Saved ${restricted ? "restricted " : ""}warp ${name}.`),
      (message) => ctx.sender.sendMessage(message));
  }
}

@Command("warp delete", { permission: "rune.admin" })
export class DeleteWarp {
  @Arg("name", { type: "word" }) name!: string;
  @Run run(ctx: CommandCtx) {
      const name = warpName(ctx, this.name);
      if (!name) return;
      warps.edit((data) => {
        if (!Object.hasOwn(data, name)) throw new StorageInputError("Warp not found.");
        delete data[name];
      }, () => ctx.sender.sendMessage(`Deleted warp ${name}.`), (message) => ctx.sender.sendMessage(message));
  }
}

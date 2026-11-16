import { normalizePositionName, snapshot, teleportTo, type Position } from "@rune/positions";
import { paperRecords, StorageInputError } from "@rune/storage";

interface Warp { point: Position; restricted: boolean }
const warps = paperRecords<Warp>(rune, "warps", "rune-warps");
rune.dashboard?.whenInstalled?.(async () => {
  if (!(rune.dashboard.apiVersion >= 2)) return;
  return (await import("./dashboard.tsx")).registerDashboard(warps.value,
    (change) => new Promise<void>((resolve, reject) => warps.edit(change, resolve, (message) => reject(new Error(message)))), canVisit);
});
const canVisit = (sender: CommandSender, name: string, warp: Warp) =>
  !warp.restricted || sender.isOp() || sender.hasPermission("rune.warp." + name);
const visibleWarps = (_partial: string, { sender }: CommandSuggestionContext) =>
  Object.entries(warps.value()).filter(([name, warp]) => canVisit(sender, name, warp)).map(([name]) => name).sort();
const warpNames = () => Object.keys(warps.value()).sort();

function registerVisitPermissions() {
  const manager = rune.bukkit.getPluginManager();
  let changed = false;
  for (const [name, warp] of Object.entries(warps.value())) {
    if (!warp.restricted) continue;
    const node = "rune.warp." + name;
    if (!manager.getPermission(node)) {
      manager.addPermission(new bukkit.permissions.Permission(node, bukkit.permissions.PermissionDefault.OP));
      changed = true;
    }
  }
  if (changed) rune.services.get<{ refresh(): void }>("permissions", 1)?.refresh?.();
}
warps.onChange(registerVisitPermissions);
rune.schedule.nextTick(registerVisitPermissions);

function warpName(ctx: CommandCtx, input: string) {
  const name = normalizePositionName(input);
  if (!name) ctx.sender.sendMessage("Use 1–24 letters, digits, underscores, or hyphens.");
  return name;
}

@Command("warp", { description: "Visit or list server warps" })
export class VisitWarp {
  @Arg("destination", { type: "word", optional: true, suggest: visibleWarps }) destination?: string;
  @Run
  run(ctx: CommandCtx) {
    if (this.destination == null) {
      const available = visibleWarps("", ctx);
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

@Command("warp set", { permission: "rune.warps.set" })
export class SaveWarp {
  @Arg("name", { type: "word", suggest: warpNames }) name!: string;
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

@Command("warp delete", { permission: "rune.warps.delete" })
export class DeleteWarp {
  @Arg("name", { type: "word", suggest: warpNames }) name!: string;
  @Run run(ctx: CommandCtx) {
      const name = warpName(ctx, this.name);
      if (!name) return;
      warps.edit((data) => {
        if (!Object.hasOwn(data, name)) throw new StorageInputError("Warp not found.");
        delete data[name];
      }, () => ctx.sender.sendMessage(`Deleted warp ${name}.`), (message) => ctx.sender.sendMessage(message));
  }
}

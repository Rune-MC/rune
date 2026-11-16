import { createCooldowns } from "@rune/cooldowns";
import { normalizePositionName, snapshot, teleportTo, type Position } from "@rune/positions";
import { paperRecords, StorageInputError } from "@rune/storage";

const homes = paperRecords<Record<string, Position>>(rune, "homes", "rune-homes");
const delays = createCooldowns();
const config = rune.config("homes", {
  "max-homes": { default: 5, min: 1, max: 100, label: "Homes per player" },
  "cooldown-seconds": { default: 10, min: 0, max: 300, label: "Teleport cooldown" },
});

function playerAction(ctx: CommandCtx, input: string | undefined, action: (player: Player, id: string, name: string) => void) {
    const { sender } = ctx;
    if (!sender.isPlayer) { sender.sendMessage("Run this command in game."); return; }
    const name = normalizePositionName(input ?? "home");
    if (!name) { sender.sendMessage("Use 1–24 letters, digits, underscores, or hyphens."); return; }
    const player = sender as unknown as Player;
    action(player, String(player.getUniqueId()), name);
}

const read = (id: string) => homes.value()[id] ?? {};
const homeNames = (_partial: string, { sender }: CommandSuggestionContext) =>
  sender.isPlayer ? Object.keys(read(String((sender as unknown as Player).getUniqueId()))).sort() : [];

function visit(player: Player, id: string, name: string) {
  const saved = read(id);
  if (!Object.hasOwn(saved, name)) throw new StorageInputError("Home not found. Save it first with /home set.");
  const wait = delays.tryStart(id, Math.floor(config.read()["cooldown-seconds"] * 1000));
  if (!wait.allowed) throw new StorageInputError(wait.retryAfterMs ? `Try again in ${Math.ceil(wait.retryAfterMs / 1000)}s.` : "Try again shortly.");
  const result = teleportTo(player, saved[name]);
  if (!result.ok) {
    delays.clear(id);
    throw new StorageInputError("That destination is currently unavailable.");
  }
}

function save(id: string, name: string, point: Position) {
  const limit = config.read()["max-homes"];
  return (data: Record<string, Record<string, Position>>) => {
    const saved = data[id] ?? {};
    if (!Object.hasOwn(saved, name) && Object.keys(saved).length >= limit) throw new StorageInputError("You reached your home limit.");
    data[id] = { ...saved, [name]: point };
  };
}

function remove(id: string, name: string) {
  return (data: Record<string, Record<string, Position>>) => {
    const saved = data[id] ?? {};
    if (!Object.hasOwn(saved, name)) throw new StorageInputError("Home not found.");
    delete saved[name];
    if (!Object.keys(saved).length) delete data[id];
  };
}

rune.dashboard?.whenInstalled?.(async () => {
  if (!(rune.dashboard.apiVersion >= 2)) return;
  const edit = (change: ReturnType<typeof save>) => new Promise<void>((resolve, reject) =>
    homes.edit(change, resolve, (message) => reject(new Error(message))));
  return (await import("./dashboard.tsx")).registerDashboard(homes.value,
    (id, name, point) => edit(save(id, name, point)), (id, name) => edit(remove(id, name)), visit);
});

@Command("home", { description: "Visit your private home" })
export class HomeVisit {
  @Arg("destination", { type: "word", optional: true, suggest: homeNames }) destination?: string;
  @Run run(ctx: CommandCtx) { playerAction(ctx, this.destination, (player, id, name) => {
    try { visit(player, id, name); }
    catch (error) {
      if (!(error instanceof StorageInputError)) throw error;
      player.sendMessage(error.message);
    }
  }); }
}

@Command("home set")
export class HomeSet {
  @Arg("name", { type: "word", optional: true, suggest: homeNames }) name?: string;
  @Run run(ctx: CommandCtx) { playerAction(ctx, this.name, (player, id, name) => {
      const point = snapshot(player.getLocation());
      homes.edit(save(id, name, point), () => player.sendMessage(`Saved home ${name}.`), (message) => player.sendMessage(message));
  }); }
}

@Command("home delete")
export class HomeDelete {
  @Arg("name", { type: "word", optional: true, suggest: homeNames }) name?: string;
  @Run run(ctx: CommandCtx) { playerAction(ctx, this.name, (player, id, name) => {
      homes.edit(remove(id, name), () => player.sendMessage(`Deleted home ${name}.`), (message) => player.sendMessage(message));
  }); }
}

@Command("home list")
export class HomeList {
  @Run run(ctx: CommandCtx) { playerAction(ctx, undefined, (player, id) => {
      const names = Object.keys(read(id)).sort();
      player.sendMessage(names.length ? "Homes: " + names.join(", ") : "You have no homes yet.");
  }); }
}

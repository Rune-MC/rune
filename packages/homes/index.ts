import { createCooldowns } from "@rune/cooldowns";
import { normalizePositionName, snapshot, teleportTo, type Position } from "@rune/positions";

const homes = rune.store("rune-homes");
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

const read = (id: string) => homes.get<Record<string, Position>>(id) ?? {};

@Command("home", { description: "Visit your private home" })
export class HomeVisit {
  @Arg("destination", { type: "word", optional: true }) destination?: string;
  @Run run(ctx: CommandCtx) { playerAction(ctx, this.destination, (player, id, name) => {
    const saved = read(id);
    if (!Object.hasOwn(saved, name)) {
      player.sendMessage("Home not found. Save it first with /home set.");
      return;
    }
    const wait = delays.tryStart(id, Math.floor(config.read()["cooldown-seconds"] * 1000));
    if (!wait.allowed) {
      player.sendMessage(wait.retryAfterMs ? `Try again in ${Math.ceil(wait.retryAfterMs / 1000)}s.` : "Try again shortly.");
      return;
    }
    const result = teleportTo(player, saved[name]);
    if (!result.ok) {
      delays.clear(id);
      player.sendMessage("That destination is currently unavailable.");
    }
  }); }
}

@Command("home set")
export class HomeSet {
  @Arg("name", { type: "word", optional: true }) name?: string;
  @Run run(ctx: CommandCtx) { playerAction(ctx, this.name, (player, id, name) => {
      const saved = read(id);
      if (!Object.hasOwn(saved, name) && Object.keys(saved).length >= config.read()["max-homes"]) {
        player.sendMessage("You reached your home limit.");
        return;
      }
      homes.set(id, { ...saved, [name]: snapshot(player.getLocation()) });
      player.sendMessage(`Saved home ${name}.`);
  }); }
}

@Command("home delete")
export class HomeDelete {
  @Arg("name", { type: "word", optional: true }) name?: string;
  @Run run(ctx: CommandCtx) { playerAction(ctx, this.name, (player, id, name) => {
      const saved = read(id);
      if (!Object.hasOwn(saved, name)) { player.sendMessage("Home not found."); return; }
      delete saved[name];
      if (Object.keys(saved).length) homes.set(id, saved);
      else homes.delete(id);
      player.sendMessage(`Deleted home ${name}.`);
  }); }
}

@Command("home list")
export class HomeList {
  @Run run(ctx: CommandCtx) { playerAction(ctx, undefined, (player, id) => {
      const names = Object.keys(read(id)).sort();
      player.sendMessage(names.length ? "Homes: " + names.join(", ") : "You have no homes yet.");
  }); }
}

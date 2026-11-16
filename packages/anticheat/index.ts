import { WindowDetector } from "./detector.ts";

const config = rune.config("anticheat", {
  enabled: { default: true, label: "Enable monitoring" },
  "speed-limit": { default: 13, min: 7, max: 80, label: "Horizontal blocks per second" },
  "hit-limit": { default: 12, min: 5, max: 30, label: "Direct melee hits per second" },
  "max-ping": { default: 200, min: 50, max: 1500, label: "Maximum measured ping in ms" },
  "min-tps": { default: 17, min: 5, max: 20, label: "Minimum server TPS" },
});
const movement = new WindowDetector();
const combat = new WindowDetector();
interface PlayerState { pauseUntil: number; lastAlert: number; alerts: number }
const state = new Map<string, PlayerState>();
const uuid = (player: Player) => String(player.getUniqueId());
let tps = 20;
rune.dashboard?.whenInstalled?.(async () => (await import("./dashboard.tsx")).registerDashboard(
  () => ({ ...config.read(), "Estimated TPS": Number(tps.toFixed(1)) }),
  () => rune.players().map((player) => ({ name: player.getName(), ping: player.getPing(), alerts: state.get(uuid(player))?.alerts ?? 0 })),
));
rune.schedule.everyTicks(() => {
  const milliseconds: unknown = rune.bukkit.getAverageTickTime();
  if (typeof milliseconds === "number" && milliseconds > 0) tps = Math.min(20, 1000 / milliseconds);
}, 20);

function read(id: string) {
  let info = state.get(id);
  if (!info) { info = { pauseUntil: 0, lastAlert: 0, alerts: 0 }; state.set(id, info); }
  return info;
}

function exempt(player: Player, options: ReturnType<typeof config.read>) {
  const mode = String(player.getGameMode());
  return !options.enabled || tps < options["min-tps"] || player.getPing() > options["max-ping"] ||
    player.hasPermission("rune.anticheat.bypass") || mode === "CREATIVE" || mode === "SPECTATOR";
}

function invalidate(id: string) {
  const info = read(id);
  info.pauseUntil = Date.now() + 2000;
  combat.clear(id);
  movement.clear(id);
}

function alert(player: Player, check: "movement" | "melee", rate: number, limit: number) {
  const playerId = uuid(player);
  const info = read(playerId);
  const now = Date.now();
  if (now - info.lastAlert < 10_000) return;
  info.lastAlert = now;
  info.alerts++;
  const name = player.getName();
  const message = `[Anticheat] ${name} ${check}: ${rate.toFixed(1)}/s (limit ${limit}/s)`;
  console.warn(message);
  for (const staff of rune.players((p) => p.isOp() || p.hasPermission("rune.anticheat.alerts"))) {
    staff.sendMessage(message);
  }
  void rune.events.emit("anticheat.alert", { playerId, name, check, rate, limit, timestamp: now });
}

@Listener
export class AnticheatListeners {
  @EventHandler(Events.PlayerMoveEvent, { priority: "MONITOR", ignoreCancelled: true })
  move(event: PlayerMoveEvent) {
    const from = event.getFrom();
    const to = event.getTo();
    if (!to || from.getWorld().getName() !== to.getWorld().getName()) return;
    const dx = to.getX() - from.getX(), dz = to.getZ() - from.getZ();
    if (!dx && !dz) return;
    const player = event.getPlayer();
    const id = uuid(player);
    const options = config.read();
    const now = Date.now();
    if (exempt(player, options) || read(id).pauseUntil > now ||
        player.isFlying() || player.isGliding() || player.isSwimming() ||
        player.isInsideVehicle() || player.isRiptiding() || player.getWalkSpeed() > 0.21 ||
        player.hasPotionEffect(bukkit.potion.PotionEffectType.SPEED)) {
      movement.clear(id);
      return;
    }
    const limit = options["speed-limit"];
    const result = movement.sample(id, Math.hypot(dx, dz), now, limit, 3);
    if (result) alert(player, "movement", result.rate, limit);
  }

  @EventHandler(Events.EntityDamageByEntityEvent, { priority: "MONITOR", ignoreCancelled: true })
  damage(event: EntityDamageByEntityEvent) {
    const damager = event.getDamager();
    if (String(damager.getType()) !== "PLAYER" || String(event.getCause()) !== "ENTITY_ATTACK") return;
    const player = damager as Player;
    const id = uuid(player);
    const options = config.read();
    if (exempt(player, options)) { combat.clear(id); return; }
    const limit = options["hit-limit"];
    const result = combat.sample(id, 1, Date.now(), limit);
    if (result) alert(player, "melee", result.rate, limit);
  }

  @EventHandler(Events.PlayerTeleportEvent, { priority: "MONITOR", ignoreCancelled: true })
  teleport(event: PlayerTeleportEvent) { invalidate(uuid(event.getPlayer())); }

  @EventHandler(Events.PlayerVelocityEvent, { priority: "MONITOR", ignoreCancelled: true })
  impulse(event: PlayerVelocityEvent) { invalidate(uuid(event.getPlayer())); }

  @EventHandler(Events.PlayerQuitEvent)
  quit(event: PlayerQuitEvent) {
    const id = uuid(event.getPlayer());
    state.delete(id);
    combat.clear(id);
    movement.clear(id);
  }
}

@Command("anticheat", { permission: "rune.anticheat.alerts", description: "Inspect anticheat monitoring" })
export class AnticheatStatus {
  @Arg("target", { type: "player", optional: true }) target?: Player;
  @Run run({ sender }: CommandCtx) {
    const status = config.read().enabled ? "enabled" : "disabled";
    sender.sendMessage(`Anticheat monitoring is ${status}. Estimated TPS: ${tps.toFixed(1)}.`);
    if (this.target) sender.sendMessage(`${this.target.getName()}: ${state.get(uuid(this.target))?.alerts ?? 0} alerts this session.`);
  }
}

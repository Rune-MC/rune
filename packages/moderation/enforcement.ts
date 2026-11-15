import { tell, uuid } from "@rune/paper-ui";
import { muteMessage, forgetChat, policy, routeChat } from "./chat.ts";
import { playerNotice } from "./cases.ts";
import { inForce } from "./model.ts";
import { backend, banFor, can, incomingIp, playerIp, punishment, settings } from "./platform.ts";

function freeze(player: Player) { return punishment("freeze", uuid(player)); }

@Listener
export class ModerationEnforcement {
  @EventHandler(Events.AsyncPlayerPreLoginEvent, { priority: "HIGHEST" })
  login(event: AsyncPlayerPreLoginEvent) {
    if (!backend.ready()) {
      event.disallow("KICK_OTHER", rune.adventure.text("Moderation data is loading. Try again shortly."));
      return;
    }
    const item = banFor(String(event.getUniqueId()).toLowerCase(), incomingIp(event.getAddress()));
    if (item) event.disallow("KICK_BANNED", rune.adventure.text(playerNotice(item)));
  }

  @EventHandler(Events.PlayerJoinEvent)
  join(event: PlayerJoinEvent) {
    const player = event.getPlayer();
    const item = banFor(uuid(player), playerIp(player));
    const lockdown = policy().lockdown;
    const reason = item ? playerNotice(item) : lockdown && inForce(lockdown) && !can(player, "use") && !can(player, "join-bypass")
      ? "The server is in lockdown. " + lockdown.reason : undefined;
    if (reason) rune.schedule.nextTick(() => { if (player.isOnline()) player.kick(rune.adventure.text(reason)); });
    else {
      for (const kind of ["mute", "freeze"] as const) {
        const restriction = punishment(kind, uuid(player));
        if (restriction) tell(player, playerNotice(restriction), "red");
      }
    }
  }

  @EventHandler(Events.PlayerQuitEvent)
  quit(event: PlayerQuitEvent) { forgetChat(event.getPlayer()); }

  @EventHandler(Events.AsyncChatEvent, { priority: "HIGH", ignoreCancelled: true })
  chat(event: AsyncChatEvent) {
    const player = event.getPlayer();
    const original = (event as unknown as { originalMessage?: { text?: string } | string }).originalMessage;
    const text = typeof original === "string" ? original : original?.text;
    const mute = muteMessage(player);
    if (mute) { event.setCancelled(true); tell(player, mute, "red"); return; }
    if (typeof text === "string" && routeChat(player, text)) event.setCancelled(true);
  }

  @EventHandler(Events.PlayerCommandPreprocessEvent, { priority: "HIGHEST", ignoreCancelled: true })
  command(event: PlayerCommandPreprocessEvent) {
    const player = event.getPlayer();
    const muted = muteMessage(player);
    if (!muted) return;
    const label = event.getMessage().slice(1).split(/\s/, 1)[0].toLowerCase().split(":").at(-1)!;
    if (!settings.read()["mute-commands"].split(",").some((entry) => entry.trim().toLowerCase() === label)) return;
    event.setCancelled(true);
    tell(player, muted, "red");
  }

  @EventHandler(Events.PlayerMoveEvent, { priority: "HIGHEST", ignoreCancelled: true })
  move(event: PlayerMoveEvent) {
    if (!freeze(event.getPlayer())) return;
    const from = event.getFrom();
    const to = event.getTo();
    if (to && (from.getX() !== to.getX() || from.getY() !== to.getY() || from.getZ() !== to.getZ())) event.setCancelled(true);
  }

  @EventHandler(Events.PlayerTeleportEvent, { priority: "HIGHEST", ignoreCancelled: true })
  teleport(event: PlayerTeleportEvent) { if (freeze(event.getPlayer())) event.setCancelled(true); }

  @EventHandler(Events.PlayerInteractEvent, { priority: "HIGHEST" })
  interact(event: PlayerInteractEvent) { if (freeze(event.getPlayer())) event.setCancelled(true); }

  @EventHandler(Events.PlayerInteractEntityEvent, { priority: "HIGHEST" })
  entity(event: PlayerInteractEntityEvent) { if (freeze(event.getPlayer())) event.setCancelled(true); }

  @EventHandler(Events.BlockBreakEvent, { priority: "HIGHEST" })
  break(event: BlockBreakEvent) { if (freeze(event.getPlayer())) event.setCancelled(true); }

  @EventHandler(Events.BlockPlaceEvent, { priority: "HIGHEST" })
  place(event: BlockPlaceEvent) { if (freeze(event.getPlayer())) event.setCancelled(true); }

  @EventHandler(Events.EntityDamageByEntityEvent, { priority: "HIGHEST", ignoreCancelled: true })
  combat(event: EntityDamageByEntityEvent) {
    const damager = event.getDamager();
    if (punishment("freeze", String(damager.getUniqueId()).toLowerCase())) event.setCancelled(true);
  }
}

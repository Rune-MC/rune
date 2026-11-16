import { ownedMetadata, putMetadata, decorateName } from "./appearance.ts";
import { backend } from "./backend.ts";
import { options, server } from "./settings.ts";
import { nextExpiration, resolveProfile } from "./resolve.ts";
import type { Context } from "./model.ts";

const attachmentKey = "rune-permissions-attachment";
const playerId = (player: Player) => String(player.getUniqueId());
const owningPlugin = () => rune.bukkit.getPluginManager().getPlugin("Rune") as Plugin;

function detach(player: Player, plugin: Plugin) {
  const metadata = ownedMetadata(player, plugin, attachmentKey);
  if (!metadata) return;
  try { player.removeAttachment(metadata.value() as PermissionAttachment); }
  catch (error) { console.warn("Could not remove previous Rune permissions attachment", error); }
  player.removeMetadata(attachmentKey, plugin);
}

function profile(id: string, context: Context = {}) {
  return resolveProfile(backend.value(), id, { server, ...context });
}

function apply(player: Player, permissionNames?: string[]) {
  const plugin = owningPlugin();
  const settings = options.read();
  const result = profile(playerId(player), { world: player.getWorld().getName() });
  detach(player, plugin);
  const rules = result.exactRules(permissionNames ?? registered());
  if (rules.size) {
    const attachment = player.addAttachment(plugin);
    try {
      for (const [node, allow] of rules) attachment.setPermission(node, allow);
      putMetadata(player, plugin, attachmentKey, attachment);
    } catch (error) {
      player.removeAttachment(attachment);
      throw error;
    }
  }
  decorateName(player, plugin, result.style("prefix", settings["stack-prefixes"]),
    result.style("suffix", settings["stack-suffixes"]),
    [settings["decorate-display-name"], settings["decorate-tab-list"]]);
  player.updateCommands();
}

function registered(): string[] {
  return rune.bukkit.getPluginManager().getPermissions().map((permission: Permission) => permission.getName());
}

let expires = Infinity;
let configured = "";
export function refresh() {
  const nodes = registered();
  for (const player of rune.players()) apply(player, nodes);
  expires = nextExpiration(backend.value(), Date.now());
  configured = JSON.stringify(options.read());
}

@Listener
export class PermissionsLifecycle {
  @EventHandler(Events.ServerLoadEvent)
  serverLoaded() { refresh(); }

  @EventHandler(Events.PlayerJoinEvent)
  join(event: PlayerJoinEvent) { apply(event.getPlayer()); }

  @EventHandler(Events.PlayerChangedWorldEvent)
  world(event: PlayerChangedWorldEvent) { apply(event.getPlayer()); }

  @EventHandler(Events.PlayerQuitEvent)
  quit(event: PlayerQuitEvent) {
    const player = event.getPlayer();
    const plugin = owningPlugin();
    detach(player, plugin);
    decorateName(player, plugin, [], [], [false, false]);
  }
}

export function startPaper() {
  backend.onChange(refresh);
  rune.schedule.nextTick(refresh);
  rune.schedule.everyTicks(() => {
    if (Date.now() >= expires || JSON.stringify(options.read()) !== configured) refresh();
  }, 20);
  rune.services.provide("permissions", 1, {
    refresh,
    groups: (id: string, context?: Context) => profile(id, context).groups.slice().sort(),
    rules: (id: string, context?: Context) => Object.fromEntries(profile(id, context).exactRules()),
    check: (id: string, node: string, context?: Context) => profile(id, context).explain(node)?.allowed,
    explain: (id: string, node: string, context?: Context) => profile(id, context).explain(node),
    meta(id: string, context?: Context) {
      const value = profile(id, context);
      const settings = options.read();
      return {
        primary: value.primary,
        prefixes: value.style("prefix", settings["stack-prefixes"]),
        suffixes: value.style("suffix", settings["stack-suffixes"]),
      };
    },
  });
}

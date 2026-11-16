export type ChatChannel = { id: string; name: string };
export const globalChannel: ChatChannel = { id: "global", name: "Global" };

type PlayerLabels = { meta(id: string, context: { world?: string }): {
  primary: string; prefixes: string[]; suffixes: string[];
} };
type PlaceholderValue = string | Component;

const papiClass = "me.clip.placeholderapi.PlaceholderAPI";
const expansionClass = "me.clip.placeholderapi.expansion.PlaceholderExpansion";
const author = "Rune Permissions";
const ownKeys = new Set(["username", "display_name", "prefix", "suffix", "group", "world", "channel", "channel_id", "message"]);

export function normalizePlaceholders(template: string) {
  return template.replace(/%rune_([a-z_]+)%/gi, (token, key: string) => {
    const name = key.toLowerCase();
    return ownKeys.has(name) ? "<" + name + ">" : token;
  });
}

function labelsFor(player: OfflinePlayer | null, world?: string) {
  if (!player) return undefined;
  return rune.services.get<PlayerLabels>("permissions", 1)?.meta(String(player.getUniqueId()), { world });
}

function style(parts: string[] | undefined, kind: "prefix" | "suffix") {
  if (!parts?.length) return "";
  const labels = parts.map((part) => rune.adventure.miniMessage(part));
  if (kind === "prefix") labels.push(rune.adventure.text(""));
  else labels.unshift(rune.adventure.text(""));
  return rune.adventure.join(labels, " ");
}

export function playerValues(player: Player, channel: ChatChannel) {
  const world = player.getWorld().getName();
  const labels = labelsFor(player, world);
  return {
    username: player.getName(), world, channel: channel.name, channel_id: channel.id,
    group: labels?.primary ?? "default",
    prefix: style(labels?.prefixes, "prefix"), suffix: style(labels?.suffixes, "suffix"),
  };
}

function papiEnabled() {
  return rune.bukkit.getPluginManager().isPluginEnabled("PlaceholderAPI");
}

export function resolveTemplate(template: string, player?: Player) {
  const values: Record<string, PlaceholderValue> = {};
  let source = normalizePlaceholders(template);
  if (!player || !source.includes("%") || !papiEnabled()) return { source, values };
  const api = rune.javaClass(papiClass);
  const resolved = new Map<string, string>();
  source = source.replace(/%[a-z0-9][a-z0-9.-]*_[^%\r\n]*%/gi, (token) => {
    const prior = resolved.get(token);
    if (prior) return prior;
    try {
      const value = String(api.setPlaceholders(player, token));
      if (value === token) return token;
      const key = "rune_papi_" + resolved.size;
      values[key] = value.includes("§")
        ? kyori.adventure.text.serializer.legacy.LegacyComponentSerializer.legacySection().deserialize(value)
        : value;
      const tag = "<" + key + ">";
      resolved.set(token, tag);
      return tag;
    } catch {
      return token;
    }
  });
  return { source, values };
}

function ownPlaceholder(player: OfflinePlayer | null, input: string): string | null {
  const key = input.toLowerCase();
  if (!ownKeys.has(key)) return null;
  const live = player?.getPlayer();
  const world = live?.getWorld().getName();
  if (key === "channel") return globalChannel.name;
  if (key === "channel_id") return globalChannel.id;
  if (key === "message") return "";
  if (key === "username") return player?.getName() ?? "";
  if (key === "display_name") return live ? rune.adventure.serialize(live.displayName(), "legacy") : player?.getName() ?? "";
  if (key === "world") return world ?? "";
  const labels = labelsFor(player, world);
  if (key === "group") return labels?.primary ?? "default";
  const parts = key === "prefix" ? labels?.prefixes : labels?.suffixes;
  return parts?.length ? rune.adventure.serialize(rune.adventure.join(parts.map((part) => rune.adventure.miniMessage(part)), " "), "legacy") : "";
}

type Expansion = { getAuthor(): string; register(): boolean };
let registered = false;

export function registerPlaceholders() {
  if (registered || !papiEnabled()) return;
  try {
    const manager = rune.javaClass("me.clip.placeholderapi.PlaceholderAPIPlugin").getInstance().getLocalExpansionManager();
    const existing = manager.getExpansion("rune") as Expansion | null;
    if (existing && existing.getAuthor() !== author) {
      console.warn("%rune_*% is already registered by another PlaceholderAPI expansion.");
      return;
    }
    const expansion = rune.implement<Expansion>(expansionClass, {
      getAuthor: () => author,
      getIdentifier: () => "rune",
      getVersion: () => "1",
      persist: () => true,
      onRequest: (player: OfflinePlayer | null, key: string) => ownPlaceholder(player, key),
    });
    expansion.getAuthor();
    registered = expansion.register();
    if (!registered) console.warn("PlaceholderAPI rejected the Rune expansion.");
  } catch (error) {
    console.warn("Could not register the Rune PlaceholderAPI expansion.", error);
  }
}

@Listener
export class PlaceholderLifecycle {
  @EventHandler(Events.PluginEnableEvent)
  enable(event: PluginEnableEvent) {
    if (event.getPlugin().getName() === "PlaceholderAPI") registerPlaceholders();
  }

  @EventHandler(Events.PluginDisableEvent)
  disable(event: PluginDisableEvent) {
    if (event.getPlugin().getName() === "PlaceholderAPI") registered = false;
  }
}

import { backend } from "../backend.ts";
import { reachable } from "../model.ts";
import { directory } from "../players.ts";
import { server } from "../settings.ts";
import { groups } from "./shared.ts";

export const playerNames = () => directory().map(({ name }) => name);
export const ranks = () => groups().filter((name) => name !== "default");
export const durations = ["permanent", "5m", "30m", "1h", "2h", "1d", "7d", "4w"];
export const priorities = ["0", "10", "25", "50", "100"];
export function subjects() {
  const names = groups();
  return [...names, ...names.map((name) => "group:" + name), ...playerNames().map((name) => "user:" + name)];
}

function permissionNodes() {
  const data = backend.value();
  const nodes = new Set<string>(rune.bukkit.getPluginManager().getPermissions()
    .map((permission: Permission) => permission.getName()));
  for (const group of Object.values(data.groups)) {
    for (const node of Object.keys(group.rules ?? {})) nodes.add(node);
    for (const rule of group.profile?.rules ?? []) nodes.add(rule.node);
  }
  for (const player of Object.values(data.players ?? {})) {
    for (const rule of player.rules ?? []) nodes.add(rule.node);
  }
  return nodes;
}

export function concreteNodes() {
  return [...permissionNodes()].filter((node) => !node.endsWith("*")).sort();
}

export function ruleNodes() {
  const nodes = permissionNodes();
  for (const node of [...nodes]) {
    for (let dot = node.indexOf("."); dot !== -1; dot = node.indexOf(".", dot + 1)) {
      nodes.add(node.slice(0, dot) + ".*");
    }
  }
  nodes.add("*");
  return [...nodes].sort();
}

export function contexts(partial: string) {
  const worlds = (rune.bukkit.getWorlds() as World[]).map((world) => "world=" + world.getName());
  const serverScope = "server=" + server;
  if (partial.includes(",")) {
    const [scope] = partial.split(",");
    if (scope.startsWith("server=")) return worlds.map((world) => `${scope},${world}`);
    if (scope.startsWith("world=")) return [`${scope},${serverScope}`];
    return [];
  }
  return ["global", serverScope, ...worlds, ...worlds.map((world) => `${serverScope},${world}`)];
}

export function possibleParents(_partial: string, ctx: CommandSuggestionContext) {
  const child = String(ctx.args.group ?? "").toLowerCase();
  const lookup = new Map(Object.entries(backend.value().groups));
  return groups().filter((name) => !reachable(lookup, [name]).has(child));
}

export function trackOrder(partial: string) {
  const prefix = partial.slice(0, partial.length - (partial.split(/\s+/).at(-1)?.length ?? 0));
  const used = new Set(prefix.trim().toLowerCase().split(/\s+/));
  return groups().filter((name) => !used.has(name)).map((name) => prefix + name);
}

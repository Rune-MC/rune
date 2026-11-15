import { isIP } from "node:net";
import { paperStore } from "@rune/storage";
import { uuid } from "@rune/paper-ui";
import { active, fail, initial, type Case, type Identity, type TimedKind } from "./model.ts";

export const backend = paperStore(rune, { id: "moderation", localName: "rune-moderation", initial });
export const server = process.env.RUNE_MODERATION_SERVER?.trim().toLowerCase() || "default";
if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(server)) throw new Error("Use a valid RUNE_MODERATION_SERVER name.");
export const settings = rune.config("moderation", {
  "report-cooldown-seconds": { default: 60, min: 0, max: 600, label: "Cooldown between reports" },
  "mute-commands": { default: "tell,msg,w,whisper,reply,r,me,emote,say,mail,staffchat", label: "Commands blocked while muted" },
});

export const mod = { permission: "rune.moderation.use" };
export const can = (sender: CommandSender, permission: string) =>
  sender.isOp() || sender.hasPermission("rune.moderation.admin") || sender.hasPermission(`rune.moderation.${permission}`);
export function requirePermission(sender: CommandSender, permission: string) {
  if (!can(sender, "use") || !can(sender, permission)) fail(`Requires rune.moderation.${permission}.`);
}
export const identity = (player: Player | OfflinePlayer): Identity => ({ id: uuid(player), name: player.getName() ?? uuid(player) });

export function actor(sender: CommandSender): Identity {
  const player = rune.players().find((p) => p.getName() === sender.getName() && p.equals(sender));
  return player ? identity(player) : { id: "server:" + sender.getName(), name: sender.getName() };
}

const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
let cachedPlayers: Identity[] = [];
let cacheExpires = 0;

export function directory() {
  if (cacheExpires <= Date.now()) {
    const known = rune.bukkit.getOfflinePlayers() as OfflinePlayer[];
    cachedPlayers = known.map(identity);
    cacheExpires = Date.now() + 20_000;
  }
  const people = new Map(cachedPlayers.map((p) => [p.id, p]));
  for (const player of rune.players()) people.set(uuid(player), identity(player));
  return [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function person(input: string): Identity {
  const key = input.trim().toLowerCase();
  const online = rune.players().find((p) => p.getName().toLowerCase() === key || uuid(p) === key);
  if (online) return identity(online);
  const known = directory().find((p) => p.id === key || p.name.toLowerCase() === key);
  if (known) return known;
  if (uuidPattern.test(key)) return { id: key, name: key };
  return fail("Use an exact known player name or a player UUID.");
}

export const online = (id: string) => rune.players().find((p) => uuid(p) === id);
export const isConsole = (sender: CommandSender) => sender.equals(rune.bukkit.getConsoleSender());

export function immune(target: Identity) {
  const player = online(target.id);
  if (player) return player.isOp() || player.hasPermission("rune.moderation.immune");
  if (!uuidPattern.test(target.id)) return false;
  const javaId = rune.javaClass("java.util.UUID").fromString(target.id);
  const offline = rune.bukkit.getOfflinePlayer(javaId) as OfflinePlayer;
  if (offline.isOp()) return true;
  return rune.services.get<{ check(id: string, node: string): boolean | undefined }>("permissions", 1)
    ?.check(target.id, "rune.moderation.immune") === true;
}

export function ipAddress(input: string) {
  const value = input.trim();
  const family = isIP(value);
  if (!family || value.includes("%")) return fail("Enter a literal IPv4 or IPv6 address.");
  if (family === 4) return value;
  const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (!mapped) return normalized;
  const first = Number.parseInt(mapped[1], 16);
  const last = Number.parseInt(mapped[2], 16);
  return [first >> 8, first & 255, last >> 8, last & 255].join(".");
}

// Rune transports java.net addresses as their Java text representation.
export function incomingIp(value: unknown) {
  if (typeof value !== "string") return undefined;
  const raw = value.slice(value.lastIndexOf("/") + 1);
  const host = /^(?:\[([^\]]+)\]|(\d+\.\d+\.\d+\.\d+)):\d+$/.exec(raw);
  const address = (host?.[1] ?? host?.[2] ?? raw).split("%")[0];
  return isIP(address) ? ipAddress(address) : undefined;
}

export const playerIp = (player: Player) => incomingIp(player.getAddress());

const penalties = new Map<string, Case>();
export function rebuild() {
  penalties.clear();
  for (const item of backend.value().cases) if (active(item)) penalties.set(`${item.kind}:${item.target.id}`, item);
}
rebuild();
backend.onChange(rebuild);
export function punishment(kind: TimedKind, id: string) {
  const item = penalties.get(`${kind}:${id}`);
  return item && active(item) ? item : undefined;
}
export function banFor(id: string, ip?: string) {
  return punishment("ban", id) ?? (ip ? punishment("ipban", ip) : undefined);
}

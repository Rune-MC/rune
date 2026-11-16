import { backend } from "./backend.ts";

export type Person = { id: string; name: string; online?: boolean; world?: string };
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
let knownPlayers: Person[] = [];
let knownUntil = 0;

export function directory(): Person[] {
  if (knownUntil <= Date.now()) {
    knownPlayers = (rune.bukkit.getOfflinePlayers() as OfflinePlayer[]).map((player) => {
      const id = String(player.getUniqueId());
      return { id, name: player.getName() ?? id };
    });
    knownUntil = Date.now() + 20_000;
  }
  const data = backend.value();
  const players = new Map<string, Person>();
  for (const id of [...Object.keys(data.members), ...Object.keys(data.players ?? {})]) players.set(id, { id, name: id });
  for (const person of knownPlayers) players.set(person.id, person);
  for (const player of rune.players()) {
    const id = String(player.getUniqueId());
    players.set(id, { id, online: true, name: player.getName(), world: player.getWorld().getName() });
  }
  return [...players.values()].sort((a, b) => Number(Boolean(b.online)) - Number(Boolean(a.online)) || a.name.localeCompare(b.name));
}

export function target(input: string): Person | undefined {
  const key = input.toLowerCase();
  return directory().find(({ id, name }) => id === key || name.toLowerCase() === key) ??
    (uuidPattern.test(key) ? { id: key, name: key } : undefined);
}

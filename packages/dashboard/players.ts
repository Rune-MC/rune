import { playerUuid } from "./avatar-url.ts";

export type PlayerOption = { id: string; name: string };
export type PlayerOptions = { options: PlayerOption[]; selected: PlayerOption | null; more: boolean };
type Directory = { all: ReadonlyMap<string, PlayerOption>; online: ReadonlyMap<string, PlayerOption> };

const asOption = (player: Player | OfflinePlayer): PlayerOption => {
  const id = String(player.getUniqueId()).toLowerCase();
  return { id, name: player.getName() ?? "Unknown player" };
};

export function createPlayerDirectory() {
  let offline = new Map<string, PlayerOption>();
  let expires = 0;
  return (availability: "known" | "online"): Directory => {
    const online = new Map(rune.players().map((player) => {
      const entry = asOption(player);
      return [entry.id, entry];
    }));
    if (availability === "known" && expires < Date.now()) {
      offline = new Map((rune.bukkit.getOfflinePlayers() as OfflinePlayer[]).map((player) => {
        const entry = asOption(player);
        return [entry.id, entry];
      }));
      expires = Date.now() + 20_000;
    }
    return { all: availability === "online" ? online : offline, online };
  };
}

export function findPlayerOptions({ all, online }: Directory, query: string, availability: "known" | "online", selected: string): PlayerOptions {
  const directory = all === online ? online : new Map([...all, ...online]);
  const needle = query.toLowerCase().trim();
  const selection = selected.toLowerCase().trim();
  const exact = (row: PlayerOption, value: string) => row.name.toLowerCase() === value || row.id === value || row.id.replaceAll("-", "") === value;
  const options = [...directory.values()].filter((row) => row.name.toLowerCase().includes(needle) ||
    row.id.includes(needle) || row.id.replaceAll("-", "").includes(needle));
  options.sort((a, b) => Number(exact(b, needle)) - Number(exact(a, needle)) ||
    Number(online.has(b.id)) - Number(online.has(a.id)) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  // Staff can explicitly target a UUID before its first login.
  if (availability === "known" && playerUuid.test(needle) && !directory.has(needle)) options.unshift({ id: needle, name: "Unseen player" });
  const current = selection ? directory.get(selection) ?? [...directory.values()].find((row) => exact(row, selection)) : undefined;
  return { options: options.slice(0, 30), selected: current ?? null, more: options.length > 30 };
}

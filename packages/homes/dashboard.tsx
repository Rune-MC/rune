/** @jsxImportSource rune:dashboard */
import { Operations, PlayerIdentity, Table } from "rune:dashboard";
import { normalizePositionName, snapshot, type Position } from "@rune/positions";

type Homes = Record<string, Record<string, Position>>;
type Save = (owner: string, name: string, position: Position) => Promise<void>;
type Remove = (owner: string, name: string) => Promise<void>;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function homeName(input: RuneDashboardValue) {
  const name = normalizePositionName(String(input));
  if (!name) throw new Error("Use 1–24 letters, digits, underscores, or hyphens.");
  return name;
}
function ownerId(input: RuneDashboardValue) {
  const key = String(input);
  if (uuid.test(key)) return key.toLowerCase();
  const online = rune.player(key);
  const player = online ?? (rune.bukkit.getOfflinePlayers() as OfflinePlayer[]).find((row) => row.getName()?.toLowerCase() === key.toLowerCase());
  if (!player) throw new Error("Choose a known player or enter their UUID.");
  return String(player.getUniqueId());
}

export function registerDashboard(read: () => Homes, save: Save, remove: Remove, visit: (player: Player, id: string, name: string) => void) {
  const name = { type: "string", label: "Home name", required: true, maxLength: 24 } as const;
  const owner = { type: "string", player: "known", label: "Home owner", required: true, maxLength: 36 } as const;
  return rune.dashboard.register({
    id: "homes", title: "Homes", navigation: [{ page: "destinations" }],
    metrics: () => ({ Owners: Object.keys(read()).length, Homes: Object.values(read()).reduce((total, homes) => total + Object.keys(homes).length, 0) }),
    pages: { destinations: { title: "Homes", render(context) {
      const query = context.query("q")?.toLowerCase().slice(0, 100) ?? "";
      const selectedOwner = context.query("owner") ?? "";
      const selectedHome = context.query("id") ?? "";
      const data = read();
      const selected = Object.hasOwn(data, selectedOwner) && Object.hasOwn(data[selectedOwner], selectedHome);
      const names = new Map<string, string>();
      for (const player of [...(rune.bukkit.getOfflinePlayers() as OfflinePlayer[]), ...rune.players()]) {
        const id = String(player.getUniqueId());
        const label = player.getName();
        if (label && Object.hasOwn(data, id)) names.set(id, label);
      }
      const rows = Object.entries(data).flatMap(([owner, homes]) => Object.entries(homes).flatMap(([name, point]) => {
        const label = names.get(owner) ?? owner;
        return [owner, label, name, point.world].some((part) => part.toLowerCase().includes(query)) ?
          [{ key: owner + ":" + name, cells: [
            <a href={context.href("destinations") + "?" + new URLSearchParams({ id: name, owner, ...(query ? { q: query } : {}) })}>{name}</a>,
            <PlayerIdentity id={owner} name={label} />, point.world, Math.floor(point.x), Math.floor(point.y), Math.floor(point.z),
          ] }] : [];
      }));
      const defaults = { name: selectedHome, owner: selectedOwner };
      return <div className="stack">
        <search aria-label="Find homes"><form className="toolbar"><label>Owner, home, or world<input type="search" name="q" defaultValue={query} maxLength={100} /></label><button type="submit">Search homes</button></form></search>
        <Table title={`Saved homes · ${rows.length} found`} columns={["Home", "Owner", "World", "X", "Y", "Z"]} rows={rows.slice(0, 200)}
          empty="No matching homes." />
        <Operations context={context} items={[
          { id: "save", label: selected ? "Move this home" : "Create home", defaults: selected ? defaults : {} },
          ...(selected ? [{ id: "visit", label: "Teleport owner to home", defaults }, { id: "delete", label: "Delete home", defaults }] : []),
        ]} />
      </div>;
    } } },
    actions: {
      save: {
        title: "Save home at a player’s position", fields: { owner, name, anchor: { type: "string", player: "online", label: "Online player at the destination", required: true, maxLength: 36 } },
        async run(input) {
          const id = ownerId(input.owner);
          const key = homeName(input.name);
          const anchor = rune.player(String(input.anchor));
          if (!anchor) throw new Error("Choose an online player at the destination.");
          await save(id, key, snapshot(anchor.getLocation()));
          return `Saved home ${key}.`;
        },
      },
      visit: {
        title: "Teleport owner to home", confirm: "Move this player to their saved home", fields: { owner: { ...owner, player: "online" }, name },
        run(input) {
          const id = ownerId(input.owner);
          const player = rune.player(id);
          if (!player) throw new Error("The owner must be online.");
          const key = homeName(input.name);
          visit(player, id, key);
          return `Teleported ${player.getName()} to ${key}.`;
        },
      },
      delete: {
        title: "Delete home", confirm: "Remove this saved home", fields: { owner, name },
        async run(input) {
          const key = homeName(input.name);
          await remove(ownerId(input.owner), key);
          return `Deleted home ${key}.`;
        },
      },
    },
  });
}

/** @jsxImportSource rune:dashboard */
import { Operations, Table } from "rune:dashboard";
import { normalizePositionName, snapshot, teleportTo, type Position } from "@rune/positions";
import { StorageInputError } from "@rune/storage";

type Warp = { point: Position; restricted: boolean };
type Edit = (change: (data: Record<string, Warp>) => void) => Promise<void>;
const warpName = (input: RuneDashboardValue) => {
  const name = normalizePositionName(String(input));
  if (!name) throw new Error("Use 1–24 letters, digits, underscores, or hyphens.");
  return name;
};
function lookup(data: Record<string, Warp>, key: string) {
  if (!Object.hasOwn(data, key)) throw new StorageInputError("Warp not found.");
  return data[key];
}
const online = (input: RuneDashboardValue) => {
  const key = String(input).toLowerCase();
  const player = rune.players().find((candidate) => candidate.getName().toLowerCase() === key || String(candidate.getUniqueId()) === key);
  if (!player) throw new Error("Choose a player who is online.");
  return player;
};

export function registerDashboard(read: () => Record<string, Warp>, edit: Edit, canVisit: (sender: CommandSender, name: string, warp: Warp) => boolean) {
  const name = { type: "string", label: "Warp name", required: true, maxLength: 24 } as const;
  const restricted = { type: "boolean", label: "Require the warp permission" } as const;
  const player = { type: "string", player: "online", label: "Online player", required: true, maxLength: 36 } as const;
  return rune.dashboard.register({
    id: "warps", title: "Warps", navigation: [{ page: "destinations" }],
    metrics: () => ({ "Saved warps": Object.keys(read()).length, Restricted: Object.values(read()).filter((warp) => warp.restricted).length }),
    pages: { destinations: { title: "Warps", render(context) {
      const data = read();
      const selected = context.query("id") ?? "";
      const warp = Object.hasOwn(data, selected) ? data[selected] : undefined;
      return <div className="stack">
        <Table title="Warps" columns={["Warp", "Access", "World", "X", "Y", "Z"]} rows={Object.entries(data).map(([id, row]) => ({
          key: id, cells: [<a href={context.href("destinations") + "?id=" + encodeURIComponent(id)}>{id}</a>,
            row.restricted ? "Restricted" : "Public", row.point.world, Math.floor(row.point.x), Math.floor(row.point.y), Math.floor(row.point.z)],
        }))} />
        <Operations context={context} items={[
          { id: "save", label: warp ? "Move this warp" : "Create warp", defaults: warp ? { name: selected, restricted: warp.restricted } : {} },
          ...(warp ? [
            { id: "access", label: "Change warp access", defaults: { name: selected, restricted: warp.restricted } },
            { id: "visit", label: "Teleport a player to this warp", defaults: { name: selected } },
            { id: "delete", label: "Delete this warp", defaults: { name: selected } },
          ] : []),
        ]} />
      </div>;
    } } },
    actions: {
      save: {
        title: "Save warp at a player’s position", fields: { name, player, restricted },
        async run(input) {
          const id = warpName(input.name);
          const point = snapshot(online(input.player).getLocation());
          await edit((data) => { data[id] = { point, restricted: input.restricted === true }; });
          return `Saved warp ${id}.`;
        },
      },
      access: {
        title: "Change warp access", fields: { name, restricted },
        async run(input) {
          const id = warpName(input.name);
          await edit((data) => { lookup(data, id).restricted = input.restricted === true; });
          return `Updated access to ${id}.`;
        },
      },
      visit: {
        title: "Teleport player to warp", confirm: "Move this online player to the warp", fields: { name, player },
        run(input) {
          const id = warpName(input.name);
          const target = online(input.player);
          const warp = lookup(read(), id);
          if (!canVisit(target as unknown as CommandSender, id, warp)) throw new Error("This player does not have access to that warp.");
          if (!teleportTo(target, warp.point).ok) throw new Error("Could not teleport to this warp.");
          return `Teleported ${target.getName()} to ${id}.`;
        },
      },
      delete: {
        title: "Delete warp", confirm: "Remove this saved warp", fields: { name },
        async run(input) {
          const id = warpName(input.name);
          await edit((data) => { lookup(data, id); delete data[id]; });
          return `Deleted warp ${id}.`;
        },
      },
    },
  });
}

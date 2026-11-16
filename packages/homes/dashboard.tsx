/** @jsxImportSource rune:dashboard */
import { Table } from "rune:dashboard";
import type { Position } from "@rune/positions";

export function registerDashboard(read: () => Record<string, Record<string, Position>>) {
  return rune.dashboard.register({
    id: "homes", title: "Homes", navigation: [{ page: "destinations" }],
    metrics: () => ({ Owners: Object.keys(read()).length, Homes: Object.values(read()).reduce((total, homes) => total + Object.keys(homes).length, 0) }),
    pages: { destinations: { title: "Homes", render(context) {
      const query = context.query("q")?.toLowerCase().slice(0, 100) ?? "";
      const online = new Map(rune.players().map((player) => [String(player.getUniqueId()), player.getName()]));
      const rows = Object.entries(read()).flatMap(([owner, homes]) => Object.entries(homes).flatMap(([name, point]) => {
        const label = online.get(owner) ?? owner;
        return [owner, label, name, point.world].some((part) => part.toLowerCase().includes(query)) ?
          [{ key: owner + ":" + name, cells: [name, label, point.world, Math.floor(point.x), Math.floor(point.y), Math.floor(point.z)] }] : [];
      }));
      return <>
        <form method="get" className="toolbar"><label>Find homes<input type="search" name="q" defaultValue={query} /></label><button>Search</button></form>
        <Table title={`Saved homes · ${rows.length}`} columns={["Home", "Owner", "World", "X", "Y", "Z"]} rows={rows.slice(0, 200)}
          empty="No matching homes." />
      </>;
    } } },
  });
}

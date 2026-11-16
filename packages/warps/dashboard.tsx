/** @jsxImportSource rune:dashboard */
import { Table } from "rune:dashboard";
import type { Position } from "@rune/positions";

export function registerDashboard(read: () => Record<string, { point: Position; restricted: boolean }>,
  update: (name: string, restricted: boolean) => Promise<void>) {
  return rune.dashboard.register({
    id: "warps", title: "Warps", navigation: [{ page: "destinations" }],
    metrics: () => ({ "Saved warps": Object.keys(read()).length, Restricted: Object.values(read()).filter((warp) => warp.restricted).length }),
    pages: { destinations: { title: "Warps", render(context) {
      const data = read();
      const selected = context.query("id");
      return <div className="stack">
        <Table title="Warps" columns={["Warp", "Access", "World", "X", "Y", "Z"]} rows={Object.entries(data).map(([name, warp]) => ({
          key: name, cells: [<a href={context.href("destinations") + "?id=" + encodeURIComponent(name)}>{name}</a>,
            warp.restricted ? "Restricted" : "Public", warp.point.world, Math.floor(warp.point.x), Math.floor(warp.point.y), Math.floor(warp.point.z)],
        }))} />
        {selected && Object.hasOwn(data, selected) && context.action("access", { name: selected, restricted: data[selected].restricted })}
      </div>;
    } } },
    actions: { access: {
      title: "Change warp access",
      fields: { name: { type: "string", required: true, maxLength: 24 }, restricted: { type: "boolean", label: "Require the warp permission" } },
      async run({ name, restricted }) { await update(String(name), restricted === true); return `Updated access to ${name}.`; },
    } },
  });
}

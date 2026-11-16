/** @jsxImportSource rune:dashboard */
import { Table } from "rune:dashboard";
import type { Position } from "@rune/positions";

export function registerDashboard(read: () => Record<string, { title: string; line: string; at: Position }>,
  update: (id: string, line: string) => Promise<void>) {
  return rune.dashboard.register({
    id: "npcs", title: "NPCs", navigation: [{ page: "registry" }],
    metrics: () => ({ "Registered NPCs": Object.keys(read()).length, Worlds: new Set(Object.values(read()).map(({ at }) => at.world)).size }),
    pages: { registry: { title: "NPCs", render(context) {
      const data = read();
      const selected = context.query("id");
      return <div className="stack">
        <Table title="NPC registry" columns={["ID", "Title", "Dialogue", "World", "Position"]} rows={Object.entries(data).map(([id, npc]) => ({
          key: id, cells: [<a href={context.href("registry") + "?id=" + encodeURIComponent(id)}>{id}</a>, npc.title, npc.line || "—",
            npc.at.world, [npc.at.x, npc.at.y, npc.at.z].map(Math.floor).join(", ")],
        }))} />
        {selected && Object.hasOwn(data, selected) && context.action("dialogue", { id: selected, line: data[selected].line })}
      </div>;
    } } },
    actions: { dialogue: {
      title: "Save NPC dialogue", fields: { id: { type: "string", required: true, maxLength: 24 },
        line: { type: "string", label: "Dialogue", maxLength: 200, multiline: true } },
      async run({ id, line }) { await update(String(id), String(line ?? "")); return `Updated ${id}.`; },
    } },
  });
}

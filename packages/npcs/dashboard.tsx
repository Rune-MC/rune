/** @jsxImportSource rune:dashboard */
import { Operations, Table } from "rune:dashboard";
import { normalizePositionName, snapshot, type Position } from "@rune/positions";
import { StorageInputError } from "@rune/storage";

type Npc = { id: string; title: string; line: string; at: Position };
type Edit = (change: (data: Record<string, Npc>) => void) => Promise<void>;
const npcId = (input: RuneDashboardValue) => {
  const id = normalizePositionName(String(input));
  if (!id) throw new Error("Use 1–24 letters, digits, underscores, or hyphens.");
  return id;
};
function lookup(data: Record<string, Npc>, id: string) {
  if (!Object.hasOwn(data, id)) throw new StorageInputError("NPC not found.");
  return data[id];
}
function position(input: RuneDashboardValue) {
  const key = String(input).toLowerCase();
  const player = rune.players().find((candidate) => candidate.getName().toLowerCase() === key || String(candidate.getUniqueId()) === key);
  if (!player) throw new Error("Choose a player who is online.");
  return snapshot(player.getLocation());
}

export function registerDashboard(read: () => Record<string, Npc>, edit: Edit) {
  const id = { type: "string", label: "NPC ID", required: true, maxLength: 24 } as const;
  const title = { type: "string", label: "Display title", maxLength: 64 } as const;
  const line = { type: "string", label: "Dialogue", maxLength: 300, multiline: true } as const;
  const anchor = { type: "string", label: "Online player to place the NPC at", required: true, maxLength: 36 } as const;
  return rune.dashboard.register({
    id: "npcs", title: "NPCs", navigation: [{ page: "registry" }],
    metrics: () => ({ "Registered NPCs": Object.keys(read()).length, Worlds: new Set(Object.values(read()).map(({ at }) => at.world)).size }),
    pages: { registry: { title: "NPCs", render(context) {
      const data = read();
      const selected = context.query("id") ?? "";
      const npc = Object.hasOwn(data, selected) ? data[selected] : undefined;
      return <div className="stack">
        <Table title="NPC registry" columns={["ID", "Title", "Dialogue", "World", "Position"]} rows={Object.entries(data).map(([key, row]) => ({
          key, cells: [<a href={context.href("registry") + "?id=" + encodeURIComponent(key)}>{key}</a>, row.title, row.line || "—",
            row.at.world, [row.at.x, row.at.y, row.at.z].map(Math.floor).join(", ")],
        }))} />
        <Operations context={context} items={[
          { id: "create", label: "Create NPC" },
          ...(npc ? [
            { id: "dialogue", label: "Edit title and dialogue", defaults: { id: selected, title: npc.title, line: npc.line } },
            { id: "move", label: "Move this NPC", defaults: { id: selected } },
            { id: "remove", label: "Remove this NPC", defaults: { id: selected } },
          ] : []),
        ]} />
      </div>;
    } } },
    actions: {
      create: {
        title: "Create NPC", fields: { id, title, line, anchor },
        async run(input) {
          const key = npcId(input.id);
          const npc = { id: key, title: String(input.title || key), line: String(input.line ?? ""), at: position(input.anchor) };
          await edit((data) => {
            if (Object.hasOwn(data, key)) throw new StorageInputError("That NPC ID is already in use.");
            data[key] = npc;
          });
          return `Created NPC ${key}.`;
        },
      },
      dialogue: {
        title: "Save NPC title and dialogue", fields: { id, title: { ...title, required: true }, line },
        async run(input) {
          const key = npcId(input.id);
          await edit((data) => {
            const npc = lookup(data, key);
            npc.title = String(input.title);
            npc.line = String(input.line ?? "");
          });
          return `Updated NPC ${key}.`;
        },
      },
      move: {
        title: "Move NPC", fields: { id, anchor },
        async run(input) {
          const key = npcId(input.id);
          const at = position(input.anchor);
          await edit((data) => { lookup(data, key).at = at; });
          return `Moved NPC ${key}.`;
        },
      },
      remove: {
        title: "Remove NPC", confirm: "Remove this NPC from the registry and world", fields: { id },
        async run(input) {
          const key = npcId(input.id);
          await edit((data) => { lookup(data, key); delete data[key]; });
          return `Removed NPC ${key}.`;
        },
      },
    },
  });
}

/** @jsxImportSource rune:dashboard */
import { Table } from "rune:dashboard";
import { backend } from "./backend.ts";
import { groupWeight } from "./changes.ts";
import { scopes, saveFormat, templateFor } from "./chat-format.ts";
import { commit } from "./commands/shared.ts";

export function registerDashboard() {
  return rune.dashboard.register({
    id: "permissions", title: "Permissions", navigation: [{ page: "groups" }, { page: "chat" }],
    metrics: () => {
      const data = backend.value();
      return { Groups: Object.keys(data.groups).length, Tracks: Object.keys(data.tracks ?? {}).length,
        "Player profiles": new Set([...Object.keys(data.members), ...Object.keys(data.players ?? {})]).size,
        "Chat formats": scopes().length };
    },
    pages: {
      groups: { title: "Permission groups", render(context) {
        const groups = backend.value().groups;
        const selected = context.query("id");
        return <div className="stack">
          <Table title="Groups" columns={["Group", "Weight", "Parents", "Rules"]} rows={Object.entries(groups).map(([id, group]) => ({
            key: id, cells: [<a href={context.href("groups") + "?id=" + encodeURIComponent(id)}>{id}</a>, group.weight ?? 0,
              group.parents.join(", ") || "—", Object.keys(group.rules).length + (group.profile?.rules?.length ?? 0)],
          }))} />
          {selected && Object.hasOwn(groups, selected) && context.action("weight", { group: selected, weight: groups[selected].weight ?? 0 })}
        </div>;
      } },
      chat: { title: "Chat formats", render(context) {
        const selected = context.query("id");
        const formats = scopes();
        return <div className="stack">
          <Table title="Chat formats" columns={["Scope", "MiniMessage template"]} rows={formats.map((id) => ({
            key: id, cells: [<a href={context.href("chat") + "?id=" + encodeURIComponent(id)}>{id}</a>, templateFor(id)],
          }))} />
          {selected && formats.includes(selected) && context.action("format", { scope: selected, template: templateFor(selected) })}
        </div>;
      } },
    },
    actions: {
      weight: {
        title: "Set group weight", fields: {
          group: { type: "string", required: true, maxLength: 32 }, weight: { type: "number", required: true, min: -100000, max: 100000 },
        },
        run({ group, weight }) {
          if (typeof weight !== "number" || !Number.isSafeInteger(weight)) throw new Error("Choose a whole number.");
          return new Promise<string>((resolve, reject) =>
            commit(rune.bukkit.getConsoleSender(), `Set ${group} weight to ${weight}.`, groupWeight(String(group), weight),
              () => resolve(`Updated ${group}.`), (message) => reject(new Error(message))));
        },
      },
      format: {
        title: "Save chat format", fields: {
          scope: { type: "string", required: true, maxLength: 64 },
          template: { type: "string", required: true, multiline: true, maxLength: 500 },
        },
        run({ scope, template }) {
          return new Promise<string>((resolve, reject) => saveFormat(rune.bukkit.getConsoleSender(), String(scope), String(template),
            () => resolve(`Saved format for ${scope}.`), (message) => reject(new Error(message))));
        },
      },
    },
  });
}

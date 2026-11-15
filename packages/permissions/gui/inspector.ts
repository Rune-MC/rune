import { backend } from "../backend.ts";
import { fail, parseContext, permissionNode } from "../commands/shared.ts";
import { resolveProfile } from "../resolve.ts";
import { server } from "../settings.ts";
import { nodePicker, registeredNodes, scopeField } from "./access.ts";
import { Menu, uuid, type Page } from "./menu.ts";
import type { Person } from "./people.ts";
import { form, list, scopeText, wrap } from "./widgets.ts";

function contextOf(person: Person) {
  const online = rune.players().find((player) => uuid(player) === person.id);
  return { server, world: online?.getWorld().getName() };
}

export function inspector(person: Person, back: Page): Page {
  const page: Page = list({
    title: "Effective permissions", back,
    rows: () => {
      const profile = resolveProfile(backend.value(), person.id, contextOf(person));
      return [...profile.exactRules(registeredNodes().map((node) => node.name))]
        .sort(([a], [b]) => a.localeCompare(b)).map(([node, allowed]) => ({
          title: node, icon: allowed ? "LIME_DYE" : "RED_DYE", color: allowed ? "green" : "red",
          lore: [allowed ? "Allowed" : "Denied", `Source: ${profile.explain(node)?.source}`, "Click to explain"],
          open: check(person, page, node),
        }));
    },
    extras: (menu) => {
      menu.button(0, "SPYGLASS", "Test any permission", ["Test a node in any server or world"], () => check(person, page)(menu.player), "green");
      menu.item(8, { icon: "COMPASS", title: person.name, lore: [scopeText(contextOf(person))] });
    },
  });
  return page;
}

function check(person: Person, back: Page, initial = ""): Page {
  return form<{ node: string; scope: string }>({
    title: "Test permission", back, submitLabel: "Run check",
    draft: { node: initial, scope: scopeText(contextOf(person)) },
    fields: [
      { title: "Permission node", icon: "PAPER", value: (draft) => draft.node || "Choose a node",
        hint: "Left-click to type • Right-click to browse",
        update: (draft, node) => ({ ...draft, node: permissionNode(node) }),
        pick: (draft, parent, select) => nodePicker(parent, (node) => select({ ...draft, node })) },
      scopeField(),
    ],
    submit: (player, draft, previous) => {
      const node = permissionNode(draft.node);
      if (node.endsWith("*")) fail("Choose a concrete permission node.");
      const context = parseContext(draft.scope) ?? {};
      const live = rune.players().find((candidate) => uuid(candidate) === person.id);
      const profile = resolveProfile(backend.value(), person.id, context);
      const result = profile.explain(node);
      const menu = new Menu(player, "Permission result", previous);
      menu.item(13, {
        icon: result ? result.allowed ? "LIME_DYE" : "RED_DYE" : "PAPER",
        title: result ? result.allowed ? "Rune allows this node" : "Rune denies this node" : "No matching Rune rule",
        color: result ? result.allowed ? "green" : "red" : "gray",
        lore: [...wrap(node), ...wrap(scopeText(context)), ...(result ? [`Source: ${result.source}`, ...wrap(`Rule: ${result.node}`)] : [])],
      });
      menu.item(22, { icon: "SHIELD", title: "Effective groups",
        lore: [`Primary: ${profile.primary}`, ...wrap(profile.groups.join(", "))] });
      if (live && scopeText(context) === scopeText(contextOf(person))) {
        menu.item(31, { icon: "COMPARATOR", title: "Live Bukkit result", lore: [live.hasPermission(node) ? "Allowed" : "Denied"] });
      }
      menu.open();
    },
  });
}

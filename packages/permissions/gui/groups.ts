import { backend } from "../backend.ts";
import { createGroup, deleteGroup, groupWeight, inherit, type Subject } from "../changes.ts";
import { groups, named } from "../commands/shared.ts";
import { reachable } from "../model.ts";
import { labels, rules } from "./access.ts";
import { canEdit, Menu, prompt, save, tell, type Page } from "./menu.ts";
import { grants, people, playerPage } from "./people.ts";
import { choose, confirm, list, numberBetween, wrap } from "./widgets.ts";

export function groupList(back: Page): Page {
  const page: Page = list({
    title: "Groups", back,
    rows: () => groups().map((id) => {
      const value = backend.value().groups[id];
      return {
        title: id, icon: id === "default" ? "IRON_HELMET" : "SHIELD",
        lore: [`Weight: ${value.weight ?? 0}`, `${value.parents.length} direct parent(s)`, "Click to open"],
        open: groupPage(id, page),
      };
    }),
    extras: (menu) => {
      if (canEdit(menu.player)) menu.button(0, "WRITABLE_BOOK", "Create group", [], () =>
        prompt(menu.player, "Name the new group", "Start with a letter. Use up to 32 letters, digits, or hyphens.", page, (input) => {
          const id = named(input);
          save(menu.player, `Created group ${id}.`, createGroup(id), groupPage(id, page), page);
        }), "green");
    },
  });
  return page;
}

function parents(id: string, back: Page): Page {
  return (player) => {
    const edit = canEdit(player);
    const page: Page = list({
      title: `${id} inheritance`, back,
      rows: () => {
        const data = backend.value();
        const direct = data.groups[id]?.parents ?? [];
        const inherited = [...reachable(new Map(Object.entries(data.groups)), direct)].sort();
        return [...new Set([...direct, ...inherited])].map((parent) => {
          const canRemove = edit && direct.includes(parent);
          const open = canRemove ? confirm("Remove direct parent?", [`${id} inherits ${parent}`], page, (player) =>
            save(player, `Removed ${parent} from ${id} inheritance.`, inherit(id, parent, false), page)) : undefined;
          return {
            title: parent, icon: "LEAD", lore: [direct.includes(parent) ? "Direct parent" : "Inherited through another group",
              ...(canRemove ? ["Click to remove"] : [])], open,
          };
        });
      },
      extras: (menu) => {
        if (!edit) return;
        const pick = choose("Select a parent group", () => {
          const state = backend.value();
          const lookup = new Map(Object.entries(state.groups));
          return groups().filter((parent) => !state.groups[id]?.parents?.includes(parent) && !reachable(lookup, [parent]).has(id))
            .map((parent) => ({ icon: "SHIELD", title: parent, open: () =>
              save(player, `${id} now inherits ${parent}.`, inherit(id, parent, true), page) }));
        }, page);
        menu.button(0, "WRITABLE_BOOK", "Add parent group", [], () => pick(player), "green");
      },
    });
    page(player);
  };
}

function groupPage(id: string, back: Page): Page {
  const page: Page = (player) => {
    const groups = backend.value().groups;
    if (!Object.hasOwn(groups, id)) { tell(player, "This group no longer exists.", "red"); back(player); return; }
    const group = groups[id];
    const subject: Subject = { type: "group", id };
    const menu = new Menu(player, id, back);
    menu.item(4, { icon: "SHIELD", title: id, lore: [`Weight: ${group.weight ?? 0}`, ...wrap(group.parents.join(", "))] });
    menu.button(11, "LEAD", "Inheritance", ["View direct and inherited parents"], () => parents(id, page)(player));
    menu.button(13, "WRITABLE_BOOK", "Group rules", ["View allow and deny rules"], () => rules(subject, id, page)(player));
    menu.button(15, "PLAYER_HEAD", "Members", ["View player profiles with direct grants"], () => people(page, playerPage, id)(player));
    menu.button(20, "NAME_TAG", "Prefixes", [], () => labels(subject, id, "prefix", page)(player));
    menu.button(24, "NAME_TAG", "Suffixes", [], () => labels(subject, id, "suffix", page)(player));
    if (canEdit(player)) {
      menu.button(29, "COMPARATOR", "Set weight", [String(group.weight ?? 0)], () =>
        prompt(player, `Set weight for ${id}`, "Enter a whole number from -100000 to 100000.", page, (input) => {
          const weight = numberBetween(input, -100000, 100000);
          save(player, `Set ${id} weight to ${weight}.`, groupWeight(id, weight), page);
        }));
      if (id !== "default") {
        menu.button(31, "EMERALD", "Grant to a player", [], () => people(page, (person, parent) => grants(person, parent, id))(player), "green");
        menu.button(33, "LAVA_BUCKET", "Delete group", [], () =>
          confirm(`Delete ${id}?`, ["Removes group grants and inheritance links.", "Updates every track that contains this group."], page, (player) =>
            save(player, `Deleted group ${id}.`, deleteGroup(id), back, page))(player), "red");
      }
    }
    menu.open();
  };
  return page;
}

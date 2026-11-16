import { directory, type Person } from "../players.ts";
export type { Person } from "../players.ts";
import { backend } from "../backend.ts";
import { editGrant, primary, type Subject } from "../changes.ts";
import { expiry, fail, groups, parseContext, target } from "../commands/shared.ts";
import type { Grant } from "../model.ts";
import { resolveProfile } from "../resolve.ts";
import { options, server } from "../settings.ts";
import { durationField, labels, rules, scopeField } from "./access.ts";
import { canEdit, Menu, prompt, save, uuid, type Page } from "./menu.ts";
import { inspector } from "./inspector.ts";
import { promotion } from "./tracks.ts";
import { choose, confirm, expirationText, form, list, scopeText, wrap } from "./widgets.ts";

export function people(back: Page, selected: (person: Person, back: Page) => Page, group?: string): Page {
  const page: Page = list({
    title: group ? `${group} members` : "Players", back,
    rows: () => {
      const data = backend.value();
      return directory().filter(({ id }) => !group || group === "default" || data.members[id]?.includes(group) ||
        data.players?.[id]?.grants?.some((entry) => entry.group === group))
        .map((person) => ({
          title: person.name, icon: person.online ? "PLAYER_HEAD" : "PAPER", search: person.id,
          color: person.online ? "green" : "aqua",
          lore: [person.online ? "Online" : "Offline", ...wrap(person.id)],
          open: selected(person, page),
        }));
    },
    extras: (menu) => {
      menu.button(0, "SPYGLASS", "Find by name or UUID", [], () =>
        lookupPerson(menu.player, page, (person) => selected(person, page)(menu.player)));
    },
  });
  return page;
}

function grantEditor(person: Person, back: Page, preset?: string, previous?: Grant): Page {
  return form<{ group: string; scope: string; duration?: string }>({
    title: previous ? "Edit group grant" : "Grant group", back,
    draft: { group: previous?.group ?? preset ?? "", scope: scopeText(previous?.context) },
    fields: [
      { title: "Group", icon: "SHIELD", value: (draft) => draft.group || "Choose a group",
        pick: (draft, parent, select) => choose("Select a group", () => groups().filter((id) => id !== "default")
          .map((id) => ({ icon: "SHIELD", title: id, open: () => select({ ...draft, group: id }) })), parent) },
      scopeField(),
      durationField(previous?.expiresAt),
    ],
    submit: (player, draft, retry) => {
      if (!draft.group) fail("Choose a group first.");
      const context = parseContext(draft.scope);
      const expires = draft.duration === undefined ? previous?.expiresAt : expiry(draft.duration);
      save(player, `Granted ${draft.group} to ${person.name} (${draft.scope}).`,
        editGrant(person.id, { group: draft.group, context, expiresAt: expires }, previous), back, retry);
    },
    extras: (menu, _draft, current) => {
      if (!previous) return;
      menu.button(51, "LAVA_BUCKET", "Revoke grant", [], () =>
        confirm("Revoke group grant?", [previous.group, scopeText(previous.context)], current, (player) =>
          save(player, `Revoked ${previous.group} from ${person.name} (${scopeText(previous.context)}).`,
            editGrant(person.id, undefined, previous), back, current))(menu.player), "red");
    },
  });
}

export function grants(person: Person, back: Page, preset?: string): Page {
  return (player) => {
    const edit = canEdit(player);
    const page: Page = list({
      title: `${person.name} group grants`, back,
      rows: () => {
        const data = backend.value();
        const direct = (data.members[person.id] ?? []).map((group) => ({ group }));
        const values: Grant[] = [...direct, ...data.players?.[person.id]?.grants ?? []];
        return values.sort((a, b) => a.group.localeCompare(b.group)).map((entry) => ({
          title: entry.group, icon: "SHIELD", lore: [scopeText(entry.context), expirationText(entry)],
          open: edit ? grantEditor(person, page, undefined, entry) : undefined,
        }));
      },
      extras: (menu) => {
        if (edit) menu.button(0, "WRITABLE_BOOK", "Grant group", [], () => grantEditor(person, page, preset)(player), "green");
      },
    });
    page(player);
  };
}

export function playerPage(person: Person, back: Page): Page {
  const page: Page = (player) => {
    const data = backend.value();
    const playerData = data.players?.[person.id];
    const online = rune.players().find((candidate) => uuid(candidate) === person.id);
    const profile = resolveProfile(data, person.id, { server, world: online?.getWorld().getName() });
    const subject: Subject = { type: "player", id: person.id };
    const settings = options.read();
    const menu = new Menu(player, online?.getName() ?? person.name, back);
    menu.item(4, { icon: online ? "PLAYER_HEAD" : "PAPER", title: online?.getName() ?? person.name,
      lore: [person.id, online ? `Online • ${online.getWorld().getName()}` : "Offline", `Primary: ${profile.primary}`, ...wrap(profile.groups.join(", "))] });
    menu.button(11, "SHIELD", "Group grants", ["View permanent, temporary, and scoped grants"], () => grants(person, page)(player));
    menu.button(13, "WRITABLE_BOOK", "Direct rules", ["View player-specific allow and deny rules"], () => rules(subject, person.name, page)(player));
    menu.button(15, "SPYGLASS", "Effective access", ["See resolved rules and test individual nodes"], () => inspector(person, page)(player));
    menu.button(20, "NAME_TAG", "Prefixes", [], () => labels(subject, person.name, "prefix", page)(player));
    menu.button(24, "NAME_TAG", "Suffixes", [], () => labels(subject, person.name, "suffix", page)(player));
    const prefixes = profile.style("prefix", settings["stack-prefixes"]);
    const suffixes = profile.style("suffix", settings["stack-suffixes"]);
    const preview = rune.adventure.join([
      ...prefixes.map((label) => rune.adventure.miniMessage(label)),
      rune.adventure.text(online?.getName() ?? person.name),
      ...suffixes.map((label) => rune.adventure.miniMessage(label)),
    ], " ");
    menu.item(22, { icon: "ARMOR_STAND", title: "Label preview",
      lore: [prefixes.length || suffixes.length ? "In the current context" : "No matching labels"], preview });
    if (canEdit(player)) {
      menu.button(29, "GOLDEN_HELMET", "Primary group", [playerData?.primary ?? "Automatic"], () => {
        const assign = (name?: string) => save(player, `Set primary group for ${person.name} to ${name ?? "automatic"}.`, primary(person.id, name), page);
        choose("Primary group", () => [
          { icon: "COMPASS", title: "Automatic", open: () => assign() },
          ...groups().map((id) => ({ icon: "SHIELD" as const, title: id, open: () => assign(id) })),
        ], page)(player);
      });
      menu.button(33, "LADDER", "Promote or demote", [], () => promotion(person, page)(player));
    }
    menu.open();
  };
  return page;
}

export function lookupPerson(player: Player, back: Page, selected: (person: Person) => void) {
  prompt(player, "Find player", "Enter an online name, a known offline name, or a UUID.", back, (value) => {
    const known = directory().find((person) => person.name.toLowerCase() === value.toLowerCase() || person.id === value.toLowerCase());
    const person = known ?? target(value);
    if (!person) fail("No known player matches. Use their UUID to open a new profile.");
    selected(person);
  });
}

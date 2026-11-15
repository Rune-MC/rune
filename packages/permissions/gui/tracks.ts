import { backend } from "../backend.ts";
import { deleteTrack, moveTrack, setTrack, trackRank } from "../changes.ts";
import { groups, named } from "../commands/shared.ts";
import { canEdit, Menu, prompt, save, tell, type Page } from "./menu.ts";
import { people, type Person } from "./people.ts";
import { choose, confirm, list, wrap } from "./widgets.ts";

function rankOnTrack(person: Person, steps: string[]) {
  const memberships = backend.value().members[person.id] ?? [];
  return trackRank(steps, new Set(memberships));
}

function trackSteps(name: string) {
  const tracks = backend.value().tracks ?? {};
  return Object.hasOwn(tracks, name) ? tracks[name] : undefined;
}

function move(person: Person, name: string, back: Page): Page {
  return (player) => {
    const steps = trackSteps(name) ?? [];
    if (!steps.length) { tell(player, "This track no longer exists.", "red"); back(player); return; }
    const rank = rankOnTrack(person, steps);
    const menu = new Menu(player, `${name} • ${person.name}`, back);
    menu.item(13, { icon: "LADDER", title: name, lore: [`Current: ${steps[rank] ?? "Unranked"}`, ...wrap(steps.join(" → "))] });
    if (canEdit(player)) {
      if (rank < steps.length - 1) menu.button(21, "LIME_DYE", "Promote", [`Next: ${steps[rank + 1]}`], () =>
        confirm("Promote player?", [person.name, `Next: ${steps[rank + 1]}`], move(person, name, back), (player) =>
          save(player, `Promoted ${person.name} on ${name}.`, moveTrack(person.id, name, 1, steps, rank), move(person, name, back)))(player), "green");
      if (rank >= 0) menu.button(23, "ORANGE_DYE", "Demote", [`Next: ${steps[rank - 1] ?? "Unranked"}`], () =>
        confirm("Demote player?", [person.name, `Next: ${steps[rank - 1] ?? "Unranked"}`], move(person, name, back), (player) =>
          save(player, `Demoted ${person.name} on ${name}.`, moveTrack(person.id, name, -1, steps, rank), move(person, name, back)))(player), "gold");
    }
    menu.open();
  };
}

export function promotion(person: Person, back: Page): Page {
  const page: Page = choose("Promotion tracks", () =>
    Object.entries(backend.value().tracks ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, steps]) => ({
      title: name, icon: "LADDER", lore: [`Current: ${steps[rankOnTrack(person, steps)] ?? "Unranked"}`], open: move(person, name, page),
    })), back);
  return page;
}

function editTrack(name: string, steps: string[], original: string[] | null, back: Page, done: Page): Page {
  const rerender = (next: string[]) => editTrack(name, next, original, back, done);
  const page: Page = list({
    title: `Edit ${name}`, back, filter: false,
    rows: () => steps.map((id, index) => ({
      title: `${index + 1}. ${id}`, icon: "SHIELD", lore: ["Click to reorder or remove"],
      open: (player) => {
        const menu = new Menu(player, id, page);
        const swap = (direction: -1 | 1) => {
          const next = steps.slice();
          [next[index], next[index + direction]] = [next[index + direction], next[index]];
          rerender(next)(player);
        };
        if (index > 0) menu.button(20, "ARROW", "Move earlier", [`Before ${steps[index - 1]}`], () => swap(-1));
        menu.button(22, "BARRIER", "Remove from track", ["Applies when you save the track"], () =>
          rerender(steps.filter((_, offset) => offset !== index))(player), "red");
        if (index + 1 < steps.length) menu.button(24, "ARROW", "Move later", [`After ${steps[index + 1]}`], () => swap(1));
        menu.open();
      },
    })),
    extras: (menu) => {
      if (steps.length < 32) menu.button(0, "WRITABLE_BOOK", "Add group", ["Appends a promotion step"], () =>
        choose("Choose next group", () => groups().filter((id) => id !== "default" && !steps.includes(id))
          .map((id) => ({ title: id, icon: "SHIELD", open: rerender([...steps, id]) })), page)(menu.player), "green");
      menu.button(49, "LIME_DYE", "Save track", [`${steps.length} of 32 steps`], () => {
        if (!steps.length) { tell(menu.player, "Add a group before saving.", "red"); return; }
        save(menu.player, `Saved track ${name}.`, setTrack(name, steps, original), done, page);
      }, "green");
    },
  });
  return page;
}

function trackPage(name: string, back: Page): Page {
  const page: Page = (player) => {
    const original = trackSteps(name);
    if (!original) { tell(player, "This track no longer exists.", "red"); back(player); return; }
    const menu = new Menu(player, name, back);
    menu.item(13, { icon: "LADDER", title: name, lore: wrap(original.join(" → ")) });
    if (canEdit(player)) {
      menu.button(20, "WRITABLE_BOOK", "Edit steps", ["Add, remove, or reorder groups"], () => editTrack(name, original, original, page, page)(player));
      menu.button(22, "PLAYER_HEAD", "Promote or demote a player", [], () => people(page, (person, previous) => move(person, name, previous))(player));
      menu.button(24, "LAVA_BUCKET", "Delete track", [], () => confirm(`Delete ${name}?`, ["Existing player grants stay in place."], page,
        (player) => save(player, `Deleted track ${name}.`, deleteTrack(name, original), back, page))(player), "red");
    }
    menu.open();
  };
  return page;
}

export function trackList(back: Page): Page {
  const page: Page = list({
    title: "Promotion tracks", back,
    rows: () => Object.entries(backend.value().tracks ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, steps]) => ({
      title: name, icon: "LADDER", lore: wrap(steps.join(" → ")), open: trackPage(name, page),
    })),
    extras: (menu) => {
      if (canEdit(menu.player)) menu.button(0, "WRITABLE_BOOK", "Create track", [], () =>
        prompt(menu.player, "Name the new track", "Start with a letter. Use up to 32 letters, digits, or hyphens.", page, (input) => {
          const name = named(input);
          if (Object.hasOwn(backend.value().tracks ?? {}, name)) { tell(menu.player, "That track already exists.", "red"); page(menu.player); return; }
          editTrack(name, [], null, page, trackPage(name, page))(menu.player);
        }), "green");
    },
  });
  return page;
}

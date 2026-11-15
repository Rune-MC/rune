import { wrap, type Page } from "@rune/paper-ui";
import { details, fail } from "../model.ts";
import { backend, can } from "../platform.ts";
import { review } from "../reports.ts";
import { targetPage } from "./cases.ts";
import { confirm, list, Menu, prompt, respond } from "./ui.ts";

function reportPage(id: number, back: Page): Page {
  const page: Page = (player) => {
    if (!can(player, "reports")) return;
    const item = backend.value().reports.find((entry) => entry.id === id) ?? fail("Report not found.");
    const menu = new Menu(player, `Report #${id}`, back);
    menu.item(13, { icon: "WRITTEN_BOOK", title: item.target.name,
      lore: [`Reported by ${item.reporter.name}`, new Date(item.at).toISOString(), ...wrap(item.reason)] });
    menu.button(22, "PLAYER_HEAD", "Open reported player", [], () => targetPage(item.target, page)(player));
    if (item.resolved) {
      menu.item(20, { icon: "LIME_DYE", title: `Resolved by ${item.resolved.actor.name}`, lore: wrap(item.resolved.reason) });
      menu.button(24, "BOOK", "Reopen report", [], () => review(player, id, "reopen", undefined, ...respond(player, page)));
    } else {
      if (item.assigned) menu.item(20, { icon: "NAME_TAG", title: `Assigned to ${item.assigned.name}` });
      else menu.button(20, "NAME_TAG", "Claim report", [], () => review(player, id, "claim", undefined, ...respond(player, page)));
      menu.button(24, "LIME_DYE", "Resolve report", [], () =>
        prompt(player, "Resolution", "Enter what you did about this report.", page, (text) =>
          confirm(`Resolve report #${id}?`, wrap(details(text)), page, (staff) =>
            review(staff, id, "resolve", text, ...respond(staff, page)))(player)), "green");
    }
    menu.open();
  };
  return page;
}

export function reports(back: Page, closed = false): Page {
  return (player) => {
    if (!can(player, "reports")) return;
    const page: Page = list({
      title: closed ? "Resolved reports" : "Open reports", back,
      rows: () => [...backend.value().reports].reverse().filter((entry) => Boolean(entry.resolved) === closed)
        .map((entry) => ({
          title: `#${entry.id} • ${entry.target.name}`, icon: closed ? "LIME_DYE" : "WRITTEN_BOOK",
          lore: [entry.assigned ? `Assigned to ${entry.assigned.name}` : "Unassigned", `From ${entry.reporter.name}`, ...wrap(entry.reason)],
          open: reportPage(entry.id, page),
        })),
      extras: (menu) => menu.button(0, "BOOK", closed ? "Open reports" : "Resolved reports", [], () => reports(back, !closed)(player)),
    });
    page(player);
  };
}

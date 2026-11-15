import { tell, wrap, type Page } from "@rune/paper-ui";
import { displayTarget, issue, undo } from "../cases.ts";
import { remaining } from "../duration.ts";
import { active, caseStatus, details, fail, isTimed, type Case, type Identity, type Kind } from "../model.ts";
import { backend, can, directory, online, person, requirePermission } from "../platform.ts";
import { choose, confirm, durationField, form, list, Menu, prompt, reasonField, respond, style } from "./ui.ts";

export function issuePage(kind: Kind, target: Identity, back: Page): Page {
  const appearance = style[kind];
  return form<{ reason: string; duration: string }>({
    title: `${appearance.name} ${target.name}`, back,
    draft: { reason: "", duration: kind === "ban" || kind === "ipban" ? "permanent" : "15m" },
    fields: [reasonField(), ...(isTimed(kind) ? [durationField<{ reason: string; duration: string }>()] : [])],
    submit: (player, draft, retry) => {
      details(draft.reason);
      confirm(`${appearance.name} ${target.name}?`,
        [...wrap(draft.reason), ...(isTimed(kind) ? [`Duration: ${draft.duration}`] : [])], retry, (staff) =>
          issue(staff, kind, target, draft.reason, draft.duration, ...respond(staff, back, retry)))(player);
    },
  });
}

function casePage(id: number, back: Page): Page {
  const page: Page = (player) => {
    const item = backend.value().cases.find((item) => item.id === id) ?? fail("Case not found.");
    const appearance = style[item.kind];
    const menu = new Menu(player, `Case #${id}`, back);
    menu.item(13, { icon: appearance.icon, title: `${appearance.name} • ${displayTarget(player, item)}`, color: appearance.color,
      lore: [caseStatus(item), ...wrap(item.reason), `By ${item.actor.name}`, new Date(item.at).toISOString()] });
    if (item.revoked) {
      menu.item(22, { icon: "PAPER", title: `Revoked by ${item.revoked.actor.name}`,
        lore: [new Date(item.revoked.at).toISOString(), ...wrap(item.revoked.reason)] });
    }
    if (isTimed(item.kind)) menu.item(31, { icon: "CLOCK", title: remaining(item.expiresAt),
      lore: item.expiresAt ? [new Date(item.expiresAt).toISOString()] : [] });
    if (!item.revoked && (!isTimed(item.kind) || active(item)) && can(player, "revoke") && can(player, item.kind)) {
      menu.button(51, "LAVA_BUCKET", "Revoke case", [], () =>
        prompt(player, "Why revoke this case?", "Enter a reason. The original case stays in the history.", page, (reason) =>
          confirm(`Revoke case #${id}?`, wrap(details(reason)), page, (staff) =>
            undo(staff, id, reason, ...respond(staff, page)))(player)), "red");
    }
    menu.open();
  };
  return page;
}

export function caseList(title: string, back: Page, filter: (item: Case) => boolean = () => true): Page {
  return (player) => {
    const page: Page = list({
      title, back,
      rows: () => [...backend.value().cases].reverse().filter(filter).map((item) => ({
        title: `#${item.id} ${style[item.kind].name} • ${displayTarget(player, item)}`,
        icon: style[item.kind].icon, color: style[item.kind].color,
        lore: [caseStatus(item), ...wrap(item.reason), item.actor.name], open: casePage(item.id, page),
      })),
    });
    page(player);
  };
}

export function targetPage(target: Identity, back: Page): Page {
  const page: Page = (player) => {
    const live = online(target.id);
    const menu = new Menu(player, target.name, back);
    menu.item(4, { icon: "PLAYER_HEAD", title: target.name, lore: [
      target.id, live ? `Online • ${live.getWorld().getName()} • ${live.getGameMode()}` : "Offline",
    ] });
    const actions = [[11, "ban"], [13, "mute"], [15, "kick"], [20, "warn"], [22, "note"], [24, "freeze"]] as const;
    for (const [slot, kind] of actions) {
      if (!can(player, kind) || (kind === "kick" && !live)) continue;
      const item = style[kind];
      menu.button(slot, item.icon, item.name, [], () => issuePage(kind, target, page)(player), item.color);
    }
    menu.button(29, "BOOK", "Case history", [], () => caseList(`${target.name} history`, page, (item) => item.target.id === target.id)(player));
    menu.button(33, "CLOCK", "Active punishments", [], () =>
      caseList(`${target.name} punishments`, page, (item) => item.target.id === target.id && active(item))(player));
    if (live && can(player, "teleport")) menu.button(31, "ENDER_PEARL", "Teleport to player", [], () => {
      requirePermission(player, "teleport");
      const current = online(target.id) ?? fail("That player has left.");
      if (!player.teleport(current.getLocation())) fail("Paper denied the teleport.");
      player.closeInventory();
      tell(player, `Teleported to ${target.name}.`, "green");
    });
    menu.open();
  };
  return page;
}

export function players(back: Page): Page {
  const page: Page = list({
    title: "Players", back,
    rows: () => {
      const live = new Set(rune.players().map((player) => String(player.getUniqueId()).toLowerCase()));
      const known = new Map(backend.value().cases.filter((item) => item.kind !== "ipban").map((item) => [item.target.id, item.target]));
      for (const player of directory()) known.set(player.id, player);
      return [...known.values()].sort((a, b) => Number(live.has(b.id)) - Number(live.has(a.id)) || a.name.localeCompare(b.name)).map((target) => ({
        title: target.name, icon: live.has(target.id) ? "PLAYER_HEAD" : "PAPER", search: target.id,
        lore: [live.has(target.id) ? "Online" : "Offline", target.id], open: targetPage(target, page),
      }));
    },
    extras(menu) {
      menu.button(0, "SPYGLASS", "Open player by name or UUID", [], () =>
        prompt(menu.player, "Find player", "Enter a known player name or UUID.", page, (text) =>
          targetPage(person(text), page)(menu.player)));
    },
  });
  return page;
}

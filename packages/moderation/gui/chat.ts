import { wrap, type Page } from "@rune/paper-ui";
import { channelId, clearChat, policy, setLock, setSlow, slowSeconds, writeChannel } from "../chat.ts";
import { expiry, remaining } from "../duration.ts";
import { details, fail, inForce, type Channel } from "../model.ts";
import { backend, can, server } from "../platform.ts";
import { confirm, durationField, form, list, Menu, prompt, reasonField, respond } from "./ui.ts";

const readDelay = (text: string) => {
  if (!/^\d+$/.test(text)) return fail("Enter a whole number of seconds.");
  return slowSeconds(Number(text));
};

function editChannel(id: string, value: Channel, back: Page): Page {
  return form<Channel>({
    title: `Channel • ${id}`, draft: value, back,
    fields: [
      { title: "Name", icon: "NAME_TAG", value: (draft) => draft.name,
        update: (draft, name) => ({ ...draft, name }) },
      { title: "Access", icon: "SHIELD", value: (draft) => draft.restricted ? "Permission required" : "Anyone can join",
        cycle: (draft) => ({ ...draft, restricted: !draft.restricted }) },
      { title: "Slow mode", icon: "CLOCK", value: (draft) => `${draft.slowSeconds}s`,
        hint: "0–600 seconds", update: (draft, text) => ({ ...draft, slowSeconds: readDelay(text) }) },
    ],
    submit: (player, draft, retry) => writeChannel(player, id, draft, ...respond(player, back, retry)),
    extras: (menu, _draft, current) => {
      if (!Object.hasOwn(backend.value().channels, id)) return;
      menu.button(51, "LAVA_BUCKET", "Delete channel", [], () =>
        confirm(`Delete ${id}?`, ["Players focused here return to global chat."], current, (player) =>
          writeChannel(player, id, undefined, ...respond(player, back, current)))(menu.player), "red");
    },
  });
}

function customChannels(back: Page): Page {
  const page: Page = list({
    title: "Manage channels", back,
    rows: () => Object.entries(backend.value().channels).sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) => ({
      title: value.name, icon: value.restricted ? "SHIELD" : "PAPER", search: id,
      lore: [id, value.restricted ? `rune.moderation.channel.${id}` : "Public", `Slow mode: ${value.slowSeconds}s`],
      open: editChannel(id, value, page),
    })),
    extras: (menu) => menu.button(0, "WRITABLE_BOOK", "Create channel", [], () =>
      prompt(menu.player, "Channel ID", "Enter a new ID with letters, digits or hyphens.", page, (input) => {
        const id = channelId(input);
        if (Object.hasOwn(backend.value().channels, id)) fail("That channel ID already exists.");
        editChannel(id, { name: id, restricted: false, slowSeconds: 0 }, page)(menu.player);
      }), "green"),
  });
  return page;
}

function lockPage(key: "locked" | "lockdown", title: string, back: Page) {
  return form<{ duration: string; reason: string }>({
    title, draft: { duration: "15m", reason: "" }, back,
    fields: [durationField(), reasonField()],
    submit(player, draft, retry) {
      expiry(draft.duration);
      details(draft.reason);
      confirm(title + "?", [draft.duration, ...wrap(draft.reason)], retry, (staff) =>
        setLock(staff, key, draft.duration, draft.reason, ...respond(staff, back, retry)))(player);
    },
  });
}

export function chatSettings(back: Page): Page {
  const page: Page = (player) => {
    const menu = new Menu(player, "Chat and lockdown", back);
    const current = policy();
    menu.item(4, { icon: "COMPARATOR", title: server,
      lore: [`Storage: ${backend.selection()} • ${backend.ready() ? "Ready" : "Loading"}`] });
    if (can(player, "chat")) {
      menu.button(11, "BOOK", "Manage channels", ["Create or configure public and restricted chat channels"], () => customChannels(page)(player));
      menu.button(13, "CLOCK", "Global slow mode", [`${current.slowSeconds ?? 0}s`], () =>
        prompt(player, "Slow mode in seconds", "Enter 0–600. Zero turns slow mode off.", page, (text) =>
          setSlow(player, readDelay(text), ...respond(player, page))));
      menu.button(20, "LAVA_BUCKET", "Clear visible chat", [], () =>
        prompt(player, "Why clear chat?", "Enter a reason to show players.", page, (text) =>
          confirm("Clear visible chat?", wrap(details(text)), page, (staff) =>
            clearChat(staff, text, ...respond(staff, page)))(player)), "red");
    }
    for (const [slot, key, permission, label] of [
      [15, "locked", "chat", "Public chat lock"], [24, "lockdown", "lockdown", "Join lockdown"],
    ] as const) {
      if (!can(player, permission)) continue;
      const lock = current[key];
      const enabled = Boolean(lock && inForce(lock));
      menu.button(slot, enabled ? "REDSTONE_BLOCK" : "LIME_DYE", label,
        enabled && lock ? [remaining(lock.expiresAt), ...wrap(lock.reason), "Click to turn off"] : ["Off • Click to configure"], () => {
          if (enabled) confirm(`Disable ${label.toLowerCase()}?`, [], page, (staff) =>
            setLock(staff, key, undefined, undefined, ...respond(staff, page)))(player);
          else lockPage(key, label, page)(player);
        }, enabled ? "red" : "green");
    }
    menu.open();
  };
  return page;
}

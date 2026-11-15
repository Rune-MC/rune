import { wrap, type Page } from "@rune/paper-ui";
import { active } from "../model.ts";
import { backend, can, ipAddress, server } from "../platform.ts";
import { caseList, issuePage, players } from "./cases.ts";
import { chatSettings } from "./chat.ts";
import { channelGui } from "./public.ts";
import { reports } from "./reports.ts";
import { list, Menu, prompt } from "./ui.ts";

function audit(back: Page) {
  return list({
    title: "Audit log", back,
    rows: () => [...backend.value().audit].reverse().map((row) => ({
      title: row.actor.name, icon: "WRITTEN_BOOK", lore: [new Date(row.at).toISOString(), ...wrap(row.action)],
    })),
  });
}

export const dashboard: Page = (player) => {
  if (!can(player, "use")) return;
  const state = backend.value();
  const open = dashboard;
  const menu = new Menu(player, "Staff dashboard");
  menu.item(4, { icon: "NETHER_STAR", title: "Moderation",
    lore: [`Server: ${server}`, `Storage: ${backend.selection()}`, ...(backend.ready() ? [] : ["Waiting for storage"])] });
  menu.button(11, "PLAYER_HEAD", "Players", ["Search online and offline profiles"], () => players(open)(player));
  menu.button(13, "BOOK", "All cases", [`${state.cases.length} recorded`], () => caseList("All cases", open)(player));
  menu.button(15, "CLOCK", "Active punishments", [], () => caseList("Active punishments", open, (item) => active(item))(player));
  if (can(player, "reports")) menu.button(20, "WRITTEN_BOOK", "Reports",
    [`${state.reports.filter((report) => !report.resolved).length} open`], () => reports(open)(player));
  if (can(player, "ipban")) menu.button(22, "IRON_BARS", "Ban an IP address", [], () =>
    prompt(player, "IP address", "Enter a literal IPv4 or IPv6 address.", open, (text) => {
      const ip = ipAddress(text);
      issuePage("ipban", { id: ip, name: ip }, open)(player);
    }), "red");
  if (can(player, "chat") || can(player, "lockdown")) menu.button(24, "COMPARATOR", "Chat and lockdown", [], () => chatSettings(open)(player));
  menu.button(29, "COMPASS", "Your chat channels", ["Join, focus, and send messages"], () => channelGui(player));
  if (can(player, "audit")) menu.button(33, "PAPER", "Audit log", ["Settings and chat actions"], () => audit(open)(player));
  menu.open();
};

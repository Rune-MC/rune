import { createMenus, createWidgets, type Page } from "@rune/paper-ui";
import { channelList, chooseChannel, routeChat } from "../chat.ts";
import { directory } from "../platform.ts";
import { report as reportPlayer } from "../reports.ts";
import { details } from "../model.ts";

const menus = createMenus({ title: "Moderation", canView: () => true });
const { Menu, prompt } = menus;
const { list } = createWidgets(menus);

export function channelGui(player: Player) {
  const page: Page = list({
    title: "Your chat channels", back: (player) => player.closeInventory(),
    rows: () => channelList(player).map((item) => ({
      title: item.name, icon: item.focused ? "LIME_DYE" : item.joined ? "PAPER" : "BOOK",
      lore: [item.id, item.focused ? "Focused" : item.joined ? "Listening" : "Available"],
      open: (player) => {
        const menu = new Menu(player, item.name, page);
        menu.button(13, "COMPASS", "Focus channel", ["Send regular chat here"], () => { chooseChannel(player, item.id, "focus"); page(player); });
        if (item.id !== "global") {
          menu.button(11, item.joined ? "BARRIER" : "BOOK", item.joined ? "Stop listening" : "Join channel", [], () => {
            chooseChannel(player, item.id, item.joined ? "leave" : "join");
            page(player);
          });
          menu.button(15, "PAPER", "Send one message", [], () =>
            prompt(player, `Message to ${item.name}`, "Enter the message you want members of this channel to receive.", page, (text) => {
              routeChat(player, details(text), item.id);
              page(player);
            }));
        }
        menu.open();
      },
    })),
  });
  page(player);
}

export function reportGui(player: Player) {
  const self = String(player.getUniqueId()).toLowerCase();
  const page: Page = list({
    title: "Report a player", back: (player) => player.closeInventory(),
    rows: () => directory().filter((target) => target.id !== self).map((target) => ({
      title: target.name, icon: "PLAYER_HEAD", search: target.id,
      open: () => prompt(player, `Report ${target.name}`, "Describe what happened. Only staff can review your report.", page, (reason) =>
        reportPlayer(player, target, reason)),
    })),
  });
  page(player);
}

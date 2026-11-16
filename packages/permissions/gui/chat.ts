import { chatPermissions, enabled, preview, saveFormat, scopes, setEnabled, templateFor } from "../chat-format.ts";
import { Menu, canView, prompt, tell, type Page } from "./menu.ts";
import { confirm, list, wrap } from "./widgets.ts";

export const canViewChat = (player: Player) => canView(player) &&
  (player.hasPermission(chatPermissions.view) || player.hasPermission(chatPermissions.edit));

function formatPage(scope: string, back: Page): Page {
  const page: Page = (player) => {
    if (!canViewChat(player)) return;
    const menu = new Menu(player, "Chat • " + scope, back);
    menu.item(13, { title: "Current format", icon: "BOOK", lore: wrap(templateFor(scope)) });
    menu.button(20, "SPYGLASS", "Preview", ["Send yourself a sample chat line"], () => {
      rune.adventure.send(player, preview(scope, templateFor(scope), player));
    });
    if (player.hasPermission(chatPermissions.edit)) {
      const finish = () => {
        if (player.isOnline() && canViewChat(player)) page(player);
      };
      const reject = (error: string) => { tell(player, error, "red"); finish(); };
      menu.button(22, "WRITABLE_BOOK", "Edit format", ["Use MiniMessage, <message>, and other placeholders"], () => {
        prompt(player, "Chat format", "Enter a MiniMessage format containing <message> or %rune_message%.", page,
          (input) => saveFormat(player, scope, input, finish, reject));
      });
      menu.button(24, "REDSTONE", "Reset format", ["Use the default for this scope"], () => {
        confirm("Reset format for " + scope, ["Use the default for this scope"], page,
          () => saveFormat(player, scope, undefined, finish, reject))(player);
      });
    }
    menu.open();
  };
  return page;
}

export function chatMenu(back: Page): Page {
  const page: Page = list({
    title: "Chat formats", back,
    rows: () => scopes().map((scope) => ({
      title: scope, icon: "PAPER", lore: wrap(templateFor(scope)), open: formatPage(scope, page),
    })),
    extras: (menu) => {
      const { player } = menu;
      const channels = rune.services.get<{
        canManage(player: Player): boolean;
        openSettings(player: Player, back: Page): void;
      }>("moderation-channels", 1);
      if (channels?.canManage?.(player)) {
        menu.button(6, "COMPARATOR", "Manage channels", ["Create channels and manage access and slow mode"],
          () => channels.openSettings(player, page));
      }
      if (!player.hasPermission(chatPermissions.edit)) return;
      const current = enabled();
      menu.button(4, current ? "LIME_DYE" : "GRAY_DYE", current ? "Formatting enabled" : "Formatting disabled",
        ["Click to toggle the formatter"], () => setEnabled(player, !current,
          () => { if (player.isOnline() && canViewChat(player)) page(player); },
          (error) => tell(player, error, "red")));
    },
  });
  return (player) => { if (canViewChat(player)) page(player); };
}

import { backend } from "../backend.ts";
import { guiPermission } from "../commands/shared.ts";
import { options, server } from "../settings.ts";
import { canViewChat, chatMenu } from "./chat.ts";
import { groupList } from "./groups.ts";
import { canEdit, Menu, tell, type Page } from "./menu.ts";
import { people, playerPage } from "./people.ts";
import { trackList } from "./tracks.ts";
import { list, wrap } from "./widgets.ts";

function audit(back: Page) {
  const page: Page = list({
    title: "Audit history", back,
    rows: () => [...backend.value().audit ?? []].reverse().map((row) => ({
      title: row.actor, icon: "WRITTEN_BOOK", lore: [new Date(row.at).toISOString(), ...wrap(row.action)],
      open: (player) => {
        const menu = new Menu(player, "Audit entry", page);
        menu.item(22, { icon: "WRITTEN_BOOK", title: row.actor, lore: [new Date(row.at).toISOString(), ...wrap(row.action)] });
        menu.open();
      },
    })),
  });
  return page;
}

function settings(back: Page): Page {
  const page: Page = (player) => {
    const menu = new Menu(player, "Settings", back);
    const config = options.read();
    const controls = [
      [11, "decorate-display-name", "Decorate display names"],
      [15, "decorate-tab-list", "Decorate the tab list"],
      [20, "stack-prefixes", "Stack prefixes"],
      [24, "stack-suffixes", "Stack suffixes"],
    ] as const;
    for (const [slot, key, title] of controls) {
      menu.item(slot, {
        title, icon: config[key] ? "LIME_DYE" : "GRAY_DYE", color: config[key] ? "green" : "gray",
        lore: [config[key] ? "On" : "Off", ...(canEdit(player) ? ["Click to toggle on this server"] : [])],
        action: canEdit(player) ? () => {
          if (!canEdit(player)) { tell(player, "Only authorized server operators can edit settings.", "red"); return; }
          options.update({ [key]: !options.read()[key] });
          page(player);
        } : undefined,
      });
    }
    menu.item(31, { icon: "BARREL", title: "Active storage",
      lore: [`Mode: ${backend.selection()}`, backend.ready() ? "Ready" : "Waiting for storage",
        "Storage changes are configured at startup."] });
    menu.open();
  };
  return page;
}

const dashboard: Page = (player) => {
  const data = backend.value();
  const menu = new Menu(player, "Admin");
  menu.item(4, { icon: "NETHER_STAR", title: "Permissions Manager",
    lore: [`Server: ${server}`, canEdit(player) ? "Operator access" : "Read-only access",
      ...(backend.ready() ? [] : ["Waiting for storage"]) ] });
  menu.button(11, "SHIELD", "Groups", [`${Object.keys(data.groups).length} groups`, "Rules, labels, members, and inheritance"], () => groupList(dashboard)(player));
  menu.button(13, "PLAYER_HEAD", "Players", ["Manage online and offline profiles"], () => people(dashboard, playerPage)(player));
  menu.button(15, "LADDER", "Promotion tracks", [`${Object.keys(data.tracks ?? {}).length} tracks`, "Configure ranks and move players"], () => trackList(dashboard)(player));
  menu.button(29, "WRITTEN_BOOK", "Audit history", [`${data.audit?.length ?? 0} recent edits`], () => audit(dashboard)(player));
  if (canViewChat(player)) {
    menu.button(31, "WRITABLE_BOOK", "Chat formats", ["Global and per-channel MiniMessage formats"], () => chatMenu(dashboard)(player));
  }
  menu.button(33, "COMPARATOR", "Settings", ["Label display and storage status"], () => settings(dashboard)(player));
  menu.open();
};

@Command("permissions gui", { ...guiPermission, description: "Open the Permissions Manager" })
export class OpenPermissionsMenu {
  @Run run({ sender }: CommandCtx) {
    if (!sender.isPlayer) { sender.sendMessage("Open the Permissions Manager in game."); return; }
    dashboard(sender as unknown as Player);
  }
}

import { createMenus, hasPrompt, menuView, tell, uuid } from "@rune/paper-ui";
import { admin, commit } from "../commands/shared.ts";
import type { PermissionState } from "../model.ts";

export { tell, uuid, type Page } from "@rune/paper-ui";
import type { Page } from "@rune/paper-ui";

export const canView = (player: Player) => player.hasPermission(admin.permission);
export const canEdit = (player: Player) => canView(player) && player.isOp();
export const menus = createMenus({ title: "Permissions", canView });
export const { Menu, prompt } = menus;
const saving = new Set<string>();

export function save(player: Player, action: string, change: (data: PermissionState) => void, done: Page, retry = done) {
  const id = uuid(player);
  if (saving.has(id)) { tell(player, "A change is still saving.", "yellow"); return; }
  const from = menuView(player);
  saving.add(id);
  const complete = (message: string, good: boolean, page: Page) => {
    saving.delete(id);
    if (!player.isOnline() || !canView(player)) return;
    tell(player, message, good ? "green" : "red");
    if (menuView(player) === from && !hasPrompt(player)) page(player);
  };
  commit(player, action, change, () => complete(action, true, done), (message) => complete(message, false, retry));
}

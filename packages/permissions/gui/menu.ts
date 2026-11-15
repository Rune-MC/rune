import { ownedMetadata, putMetadata } from "../appearance.ts";
import { admin, commit } from "../commands/shared.ts";
import type { PermissionState } from "../model.ts";

export type Page = (player: Player) => void;
export type Click = "left" | "right";
type Action = (click: Click) => void;
export type Icon = keyof typeof bukkit.Material;
type Entry = { icon: Icon; title: string; lore?: string[]; color?: string; action?: Action; preview?: Component };
type View = { inventory: Inventory; actions: Map<number, Action> };
type Prompt = { expires: number; accept: (value: string) => void; back: Page };

const views = new Map<string, View>();
const prompts = new Map<string, Prompt>();
const saving = new Set<string>();
const marker = "rune-permissions-menu";
let trim: ItemStack | undefined;
const owner = () => rune.bukkit.getPluginManager().getPlugin("Rune") as Plugin;
export const uuid = (player: Player | OfflinePlayer) => String(player.getUniqueId()).toLowerCase();
export const canView = (player: Player) => player.hasPermission(admin.permission);
export const canEdit = (player: Player) => canView(player) && player.isOp();
const literal = (text: string) => text.replaceAll("\\", "\\\\").replaceAll("<", "\\<");
export const tell = (player: Player, text: string, color = "aqua") => rune.adventure.send(player, rune.adventure.text(text, color));

function tracked(player: Player, inventory: Inventory): boolean {
  const prior = ownedMetadata(player, owner(), marker)?.value() as Inventory | undefined;
  return Boolean(prior?.equals(inventory));
}

export class Menu {
  readonly inventory: Inventory;
  private actions = new Map<number, Action>();

  constructor(readonly player: Player, title: string, parent?: Page) {
    this.inventory = rune.bukkit.createInventory(null, 54, rune.adventure.text(`Permissions › ${title}`, "dark_aqua"));
    trim ??= rune.item(bukkit.Material.GRAY_STAINED_GLASS_PANE).name(" ").build();
    for (const slot of [9, 17, 18, 26, 27, 35, 36, 44, 46, 48, 50, 52]) this.inventory.setItem(slot, trim);
    if (parent) this.button(45, "ARROW", "Back", [], () => parent(player));
    this.button(53, "BARRIER", "Close", [], () => player.closeInventory(), "red");
  }

  item(slot: number, { icon, title, lore = [], color = "aqua", action, preview }: Entry) {
    const stack = rune.item(bukkit.Material[icon] as Material)
      .name(`<!italic><${color}>${literal(title)}`)
      .lore(lore.map((line) => `<!italic><gray>${literal(line)}`)).build();
    if (preview) {
      const meta = stack.getItemMeta();
      if (meta) {
        meta.lore([...(meta.lore() ?? []), preview]);
        stack.setItemMeta(meta);
      }
    }
    this.inventory.setItem(slot, stack);
    if (action) this.actions.set(slot, action);
  }

  button(slot: number, icon: Icon, title: string, lore: string[], action: Action, color?: string) {
    this.item(slot, { icon, title, lore, color, action });
  }

  open() {
    const player = this.player;
    if (!player.isOnline() || !canView(player)) return;
    const id = uuid(player);
    prompts.delete(id);
    views.set(id, { inventory: this.inventory, actions: this.actions });
    putMetadata(player, owner(), marker, this.inventory);
    player.openInventory(this.inventory);
    if (!player.getOpenInventory().getTopInventory().equals(this.inventory)) forget(player);
  }
}

export function forget(player: Player) {
  const id = uuid(player);
  views.delete(id);
  prompts.delete(id);
  player.removeMetadata(marker, owner());
}

export function prompt(player: Player, title: string, hint: string, back: Page, accept: Prompt["accept"]) {
  if (!canView(player)) return;
  player.closeInventory();
  prompts.set(uuid(player), { accept, back, expires: Date.now() + 60_000 });
  tell(player, title);
  tell(player, hint, "gray");
  tell(player, "Type in chat within 60 seconds, or type !cancel. You can also use /permissions input <text>.", "gray");
}

export function pending(player: Player) {
  const id = uuid(player);
  const request = prompts.get(id);
  if (request && request.expires > Date.now() && canView(player)) return request;
  prompts.delete(id);
  return undefined;
}

export function submit(player: Player, text: string) {
  const request = pending(player);
  if (!request) { tell(player, "No active Permissions input.", "red"); return; }
  prompts.delete(uuid(player));
  if (text.trim().toLowerCase() === "!cancel") { request.back(player); return; }
  try { request.accept(text.trim()); }
  catch (error) {
    tell(player, error instanceof Error ? error.message : "Invalid input.", "red");
    request.back(player);
  }
}

export function save(player: Player, action: string, change: (data: PermissionState) => void, done: Page, retry = done) {
  const id = uuid(player);
  if (saving.has(id)) { tell(player, "A change is still saving.", "yellow"); return; }
  const from = views.get(id);
  saving.add(id);
  const complete = (message: string, good: boolean, page: Page) => {
    saving.delete(id);
    if (!player.isOnline() || !canView(player)) return;
    tell(player, message, good ? "green" : "red");
    if (views.get(id) === from && !pending(player)) page(player);
  };
  commit(player, action, change, () => complete(action, true, done), (message) => complete(message, false, retry));
}

@Listener
export class PermissionMenus {
  @EventHandler(Events.InventoryClickEvent, { priority: "HIGHEST" })
  click(event: InventoryClickEvent) {
    const player = event.getWhoClicked() as Player;
    const inventory = event.getInventory();
    if (!tracked(player, inventory)) return;
    event.setCancelled(true);
    const id = uuid(player);
    const view = views.get(id);
    const action = view?.actions.get(event.getRawSlot());
    if (!action || !view?.inventory.equals(inventory)) return;
    const click = (event as unknown as { click: string }).click;
    if (click !== "LEFT" && click !== "RIGHT") return;
    rune.schedule.nextTick(() => {
      if (view !== views.get(id) || !player.isOnline()) return;
      if (!canView(player)) { player.closeInventory(); return; }
      try { action(click === "LEFT" ? "left" : "right"); }
      catch (error) { tell(player, error instanceof Error ? error.message : "Unable to complete that action.", "red"); }
    });
  }

  @EventHandler(Events.InventoryCreativeEvent, { priority: "HIGHEST" })
  creative(event: InventoryCreativeEvent) {
    if (tracked(event.getWhoClicked() as Player, event.getInventory())) event.setCancelled(true);
  }

  @EventHandler(Events.InventoryDragEvent, { priority: "HIGHEST" })
  drag(event: InventoryDragEvent) {
    if (tracked(event.getWhoClicked() as Player, event.getInventory())) event.setCancelled(true);
  }

  @EventHandler(Events.InventoryCloseEvent)
  close(event: InventoryCloseEvent) {
    const player = event.getPlayer() as Player;
    if (tracked(player, event.getInventory())) forget(player);
  }

  @EventHandler(Events.PlayerQuitEvent)
  quit(event: PlayerQuitEvent) { forget(event.getPlayer()); }

  @EventHandler(Events.AsyncChatEvent, { priority: "LOWEST" })
  chat(event: AsyncChatEvent) {
    const player = event.getPlayer();
    const request = pending(player);
    if (!request) return;
    // Rune's event snapshots expose Adventure Components with their plain text.
    const { originalMessage } = event as unknown as { originalMessage?: { text?: string } | string };
    const message = typeof originalMessage === "string" ? originalMessage : originalMessage?.text;
    if (typeof message !== "string") return;
    event.setCancelled(true);
    rune.schedule.nextTick(() => { if (pending(player) === request) submit(player, message); });
  }
}

// Close inventories created by an earlier instance when a Rune reloads.
rune.schedule.nextTick(() => {
  for (const player of rune.players()) {
    if (views.has(uuid(player))) continue;
    if (tracked(player, player.getOpenInventory().getTopInventory())) player.closeInventory();
    forget(player);
  }
});

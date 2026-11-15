export type Page = (player: Player) => void;
export type Click = "left" | "right";
export type Icon = keyof typeof bukkit.Material;
type Action = (click: Click) => void;
type Entry = { icon: Icon; title: string; lore?: string[]; color?: string; action?: Action; preview?: Component };
type Theme = { title: string; canView: (player: Player) => boolean };
type LegacyPrompt = { spec: GuiPromptSpec; deadline: number; timer: unknown; used: boolean };

const views = new Map<string, Gui>();
const legacyPrompts = new Map<string, LegacyPrompt>();
const marker = "rune-paper-ui-inventory";
let trim: ItemStack | undefined;
const owner = () => rune.bukkit.getPluginManager().getPlugin("Rune") as Plugin;
export const uuid = (player: Player | OfflinePlayer) => String(player.getUniqueId()).toLowerCase();
export const menuView = (player: Player) => views.get(uuid(player));
export const tell = (to: CommandSender, text: string, color = "aqua") =>
  rune.adventure.send(to, rune.adventure.text(text, color));
const literal = (text: string) => text.replaceAll("\\", "\\\\").replaceAll("<", "\\<");

function inventoryFor(player: Player, key = marker) {
  return player.getMetadata(key).find((meta) => meta.getOwningPlugin()?.getName() === "Rune")?.value() as Inventory | undefined;
}

function removeLegacy(id: string) {
  const request = legacyPrompts.get(id);
  if (!request) return;
  legacyPrompts.delete(id);
  rune.schedule.cancel(request.timer);
}

function pendingLegacy(player: Player, id: string) {
  const request = legacyPrompts.get(id);
  if (!request) return;
  if (request.spec.canReply && !request.spec.canReply(player)) { removeLegacy(id); return; }
  if (!request.used && Date.now() >= request.deadline) {
    removeLegacy(id);
    request.spec.onTimeout?.(player);
    return;
  }
  return request;
}

export function hasPrompt(player: Player) {
  if (typeof rune.gui.hasPrompt === "function") return rune.gui.hasPrompt(player);
  return Boolean(pendingLegacy(player, uuid(player)));
}

function cancelPrompt(player: Player) {
  if (typeof rune.gui.cancelPrompt === "function") rune.gui.cancelPrompt(player);
  else removeLegacy(uuid(player));
}

function legacyPrompt(player: Player, spec: GuiPromptSpec) {
  const id = uuid(player);
  const timeout = spec.timeoutMs ?? 60_000;
  player.closeInventory();
  const request: LegacyPrompt = {
    spec, deadline: Date.now() + timeout, used: false,
    timer: rune.schedule.afterMs(() => {
      if (legacyPrompts.get(id) !== request || request.used) return;
      removeLegacy(id);
      if (player.isOnline() && (!spec.canReply || spec.canReply(player))) spec.onTimeout?.(player);
    }, timeout),
  };
  legacyPrompts.set(id, request);
  if (spec.title) rune.adventure.send(player, spec.title);
  if (spec.hint) rune.adventure.send(player, spec.hint);
}

export class MenuInstance {
  private readonly gui: Gui;

  constructor(theme: Theme, readonly player: Player, title: string, parent?: Page) {
    this.theme = theme;
    this.gui = rune.gui({ rows: 6, title: `<dark_aqua>${literal(theme.title + " › " + title)}` });
    trim ??= rune.item(bukkit.Material.GRAY_STAINED_GLASS_PANE).name(" ").build();
    for (const slot of [9, 17, 18, 26, 27, 35, 36, 44, 46, 48, 50, 52]) this.gui.slot(slot, trim);
    if (parent) this.button(45, "ARROW", "Back", [], () => parent(player));
    this.button(53, "BARRIER", "Close", [], () => player.closeInventory(), "red");
    this.gui.onClose(() => {
      if (views.get(uuid(player)) !== this.gui) return;
      views.delete(uuid(player));
      player.removeMetadata(marker, owner());
    });
  }

  private readonly theme: Theme;

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
    this.gui.slot(slot, stack, action && ((event) => {
      const click = (event as unknown as { click: string }).click;
      if (click !== "LEFT" && click !== "RIGHT") return;
      rune.schedule.nextTick(() => {
        if (!this.player.isOnline() || views.get(uuid(this.player)) !== this.gui) return;
        if (!this.theme.canView(this.player)) { this.player.closeInventory(); return; }
        try { action(click === "LEFT" ? "left" : "right"); }
        catch (error) { tell(this.player, error instanceof Error ? error.message : "Unable to complete that action.", "red"); }
      });
    }));
  }

  button(slot: number, icon: Icon, title: string, lore: string[], action: Action, color?: string) {
    this.item(slot, { icon, title, lore, action, color });
  }

  open() {
    const { player } = this;
    if (!player.isOnline() || !this.theme.canView(player)) return;
    cancelPrompt(player);
    const id = uuid(player);
    views.set(id, this.gui);
    player.setMetadata(marker, new bukkit.metadata.FixedMetadataValue(owner(), this.gui.inventory));
    this.gui.open(player);
    if (!player.getOpenInventory().getTopInventory().equals(this.gui.inventory)) {
      views.delete(id);
      player.removeMetadata(marker, owner());
    }
  }
}

export function createMenus(theme: Theme) {
  class Menu extends MenuInstance {
    constructor(player: Player, title: string, back?: Page) { super(theme, player, title, back); }
  }
  function prompt(player: Player, title: string, hint: string, back: Page, accept: (text: string) => void) {
    if (!theme.canView(player)) return;
    cancelPrompt(player);
    const spec: GuiPromptSpec = {
      title: rune.adventure.text(title, "aqua"),
      hint: rune.adventure.text(hint + "\nType your reply in chat within 60 seconds. Your reply is private. Type !cancel to go back.", "gray"),
      canReply: theme.canView,
      onCancel: back,
      onTimeout: () => tell(player, "The prompt expired. Chat has resumed.", "yellow"),
      onReply(text) {
        try { accept(text); }
        catch (error) {
          tell(player, error instanceof Error ? error.message : "Invalid input.", "red");
          back(player);
        }
      },
    };
    if (typeof rune.gui.prompt === "function") rune.gui.prompt(player, spec);
    else legacyPrompt(player, spec);
  }
  return { Menu, prompt };
}

export type MenuToolkit = ReturnType<typeof createMenus>;

@Listener
export class PaperUiCompatibility {
  @EventHandler(Events.InventoryDragEvent, { priority: "HIGHEST", ignoreCancelled: true })
  drag(event: InventoryDragEvent) {
    if (inventoryFor(event.getWhoClicked() as Player)?.equals(event.getInventory())) event.setCancelled(true);
  }

  @EventHandler(Events.InventoryCreativeEvent, { priority: "HIGHEST", ignoreCancelled: true })
  creative(event: InventoryCreativeEvent) {
    if (inventoryFor(event.getWhoClicked() as Player)?.equals(event.getInventory())) event.setCancelled(true);
  }

  @EventHandler(Events.PlayerQuitEvent)
  quit(event: PlayerQuitEvent) {
    const player = event.getPlayer();
    cancelPrompt(player);
    views.delete(uuid(player));
    player.removeMetadata(marker, owner());
  }

  @EventHandler(Events.AsyncChatEvent, { priority: "LOWEST" })
  chat(event: AsyncChatEvent) {
    if (!legacyPrompts.size) return;
    const player = event.getPlayer();
    const id = uuid(player);
    const request = pendingLegacy(player, id);
    if (!request) return;
    event.setCancelled(true);
    if (request.used) return;
    type Text = string | { text?: string };
    const { originalMessage, message } = event as unknown as { originalMessage?: Text; message?: Text };
    const value = originalMessage ?? message;
    const text = typeof value === "string" ? value : value?.text;
    if (typeof text !== "string") return;
    request.used = true;
    rune.schedule.nextTick(() => {
      if (pendingLegacy(player, id) !== request) return;
      removeLegacy(id);
      if (text.trim().toLowerCase() === "!cancel") request.spec.onCancel?.(player);
      else request.spec.onReply(text.trim(), player);
    });
  }
}

rune.schedule.nextTick(() => {
  for (const player of rune.players()) {
    if (views.has(uuid(player))) continue;
    const inventory = player.getOpenInventory().getTopInventory();
    for (const key of [marker, "rune-permissions-menu"]) {
      if (inventoryFor(player, key)?.equals(inventory)) player.closeInventory();
      player.removeMetadata(key, owner());
    }
  }
});

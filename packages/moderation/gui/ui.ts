import { createMenus, createWidgets, hasPrompt, menuView, tell, type Page } from "@rune/paper-ui";
import { can } from "../platform.ts";
import { durationHelp, expiry } from "../duration.ts";
import { details, type Kind } from "../model.ts";

const menus = createMenus({ title: "Moderation", canView: (player) => can(player, "use") });
export const { Menu, prompt } = menus;
export const { list, choose, form, confirm } = createWidgets(menus);

export const style = {
  ban: { icon: "BARRIER", name: "Ban", color: "red" },
  ipban: { icon: "IRON_BARS", name: "IP ban", color: "red" },
  mute: { icon: "BELL", name: "Mute", color: "gold" },
  freeze: { icon: "ICE", name: "Freeze", color: "blue" },
  kick: { icon: "IRON_BOOTS", name: "Kick", color: "red" },
  warn: { icon: "ORANGE_DYE", name: "Warn", color: "gold" },
  note: { icon: "WRITABLE_BOOK", name: "Staff note", color: "aqua" },
} as const satisfies Record<Kind, { icon: string; name: string; color: string }>;

export function durationField<T extends { duration: string }>() {
  return {
    title: "Duration", icon: "CLOCK" as const, value: (draft: T) => draft.duration,
    hint: "Left-click to type • Right-click for presets",
    update: (draft: T, duration: string) => { expiry(duration); return { ...draft, duration }; },
    pick: (draft: T, back: Page, select: (value: T) => void) => choose("Duration", () =>
      ["30s", "5m", "15m", "1h", "1d", "1w", "1mo", "1y", "permanent"].map((duration) => ({
        icon: "CLOCK", title: duration, lore: [durationHelp], open: () => select({ ...draft, duration }),
      })), back),
  };
}

export function reasonField<T extends { reason: string }>() {
  return {
    title: "Reason", icon: "WRITABLE_BOOK" as const, value: (draft: T) => draft.reason.slice(0, 42) || "Enter a reason",
    hint: "1–240 characters", update: (draft: T, reason: string) => ({ ...draft, reason: details(reason) }),
  };
}

export function respond(player: Player, done: Page, retry = done) {
  const view = menuView(player);
  const finish = (message: string, success: boolean) => {
    if (!player.isOnline() || !can(player, "use")) return;
    tell(player, message, success ? "green" : "red");
    if (menuView(player) === view && !hasPrompt(player)) (success ? done : retry)(player);
  };
  return [(message: string) => finish(message, true), (message: string) => finish(message, false)] as const;
}

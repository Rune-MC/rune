import { createWidgets } from "@rune/paper-ui";
import { fail } from "../commands/shared.ts";
import type { Context, Scoped } from "../model.ts";
import { menus } from "./menu.ts";

export { wrap } from "@rune/paper-ui";
export const { list, choose, confirm, form } = createWidgets(menus);

export function scopeText(scope?: Context) {
  return [scope?.server && `server=${scope.server}`, scope?.world && `world=${scope.world}`].filter(Boolean).join(",") || "global";
}

export function expirationText(scoped: Scoped) {
  if (scoped.expiresAt === undefined) return "Permanent";
  const date = new Date(scoped.expiresAt).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  return scoped.expiresAt <= Date.now() ? `Expired • ${date}` : `Expires • ${date}`;
}

export function numberBetween(input: string, min: number, max: number) {
  if (!/^-?\d+$/.test(input) || Number(input) < min || Number(input) > max) fail(`Enter a whole number from ${min} to ${max}.`);
  return Number(input);
}

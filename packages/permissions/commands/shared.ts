import { StorageInputError } from "@rune/storage";
import { backend } from "../backend.ts";
import { scopeKey, type Access, type Context, type PermissionState, type Scoped } from "../model.ts";

export const admin = { permission: "rune.admin" };
export const verb = ["allow", "deny", "unset"];
const idPattern = /^[a-z][a-z0-9-]{0,31}$/;
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function fail(message: string): never { throw new StorageInputError(message); }
export function named(value: string) {
  const key = value.toLowerCase();
  return idPattern.test(key) ? key : fail("Use a name of 1–32 letters, digits, or hyphens.");
}
export function group(data: PermissionState, value: string) {
  const id = named(value);
  if (!Object.hasOwn(data.groups, id)) fail("Unknown permission group.");
  return { id, value: data.groups[id] };
}
export const groups = () => Object.keys(backend.value().groups).sort();
export const tracks = () => Object.keys(backend.value().tracks ?? {}).sort();

export function target(input: string) {
  if (uuidPattern.test(input)) return { id: input.toLowerCase(), name: input };
  const online = rune.player(input);
  if (!online) return undefined;
  return { id: String(online.getUniqueId()).toLowerCase(), name: online.getName(), world: online.getWorld().getName() };
}

export function parseContext(input?: string): Context | undefined {
  if (!input || input === "global") return undefined;
  const result: Context = {};
  for (const part of input.split(",")) {
    const match = /^(server|world)=([a-zA-Z0-9_.:-]{1,80})$/.exec(part);
    if (!match) fail("Use global, world=name, server=name, or server=name,world=name.");
    const key = match[1] as keyof Context;
    if (result[key]) fail("Repeat each context key at most once.");
    result[key] = match[2];
  }
  return result;
}

export function expiry(input?: string) {
  if (!input || input === "permanent") return undefined;
  const match = /^(\d{1,5})(m|h|d|w)$/.exec(input);
  if (!match) fail("Use a duration like 30m, 2h, 7d, or permanent.");
  const units = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  const duration = Number(match[1]) * units[match[2] as keyof typeof units];
  if (duration <= 0 || duration > 366 * units.d) fail("Use a duration of 1 minute to 366 days.");
  return Date.now() + duration;
}

export function permissionNode(input: string) {
  const node = input.toLowerCase();
  if (!/^(?:\*|[a-z0-9_-]+(?:\.[a-z0-9_-]+)*(?:\.\*)?)$/.test(node) || node.length > 128) {
    fail("Use a permission node such as example.build or example.*.");
  }
  return node;
}

export function playerAccess(data: PermissionState, id: string) {
  return ((data.players ??= {})[id] ??= {});
}

export function groupAccess(data: PermissionState, key: string): Access {
  return group(data, key).value.profile ??= {};
}

export function matchesContext(value: Scoped, context?: Context) {
  return scopeKey(value.context) === scopeKey(context);
}

export function edit(ctx: CommandCtx, action: string, transform: (data: PermissionState) => void) {
  if (!ctx.sender.isOp()) { ctx.sender.sendMessage("Only server operators can edit access."); return; }
  const actor = ctx.sender.getName();
  const at = Date.now();
  backend.edit((data) => {
    transform(data);
    data.audit = [...(data.audit ?? []).slice(-199), { actor, action, at }];
  }, () => ctx.sender.sendMessage(action), (message) => ctx.sender.sendMessage(message));
}

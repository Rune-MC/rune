import { backend } from "../backend.ts";
import type { Context, PermissionState } from "../model.ts";
import { fail } from "../validation.ts";

export { fail, named } from "../validation.ts";
export { target } from "../players.ts";

export const permit = (action: string) => ({ permission: "rune.permissions." + action });
export const guiPermission = permit("gui");
export const verb = ["allow", "deny", "unset"];
export const groups = () => Object.keys(backend.value().groups).sort();
export const tracks = () => Object.keys(backend.value().tracks ?? {}).sort();


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

export function edit(ctx: CommandCtx, action: string, transform: (data: PermissionState) => void) {
  commit(ctx.sender, action, transform, () => ctx.sender.sendMessage(action), (message) => ctx.sender.sendMessage(message));
}

export function commit(sender: CommandSender, action: string, transform: (data: PermissionState) => void,
  done: () => void, reject: (message: string) => void,
) {
  if (!sender.isOp()) {
    reject("Only authorized server operators can edit access.");
    return;
  }
  const actor = sender.getName();
  const at = Date.now();
  backend.edit((data) => {
    transform(data);
    data.audit = [...(data.audit ?? []).slice(-199), { actor, action, at }];
  }, done, reject);
}

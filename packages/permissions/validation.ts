import { StorageInputError } from "@rune/storage";
import { scopeKey, type Access, type Context, type PermissionState, type Scoped } from "./model.ts";

const idPattern = /^[a-z][a-z0-9-]{0,31}$/;

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

export function playerAccess(data: PermissionState, id: string) {
  return ((data.players ??= {})[id] ??= {});
}

export function groupAccess(data: PermissionState, key: string): Access {
  return group(data, key).value.profile ??= {};
}

export function matchesContext(value: Scoped, context?: Context) {
  return scopeKey(value.context) === scopeKey(context);
}

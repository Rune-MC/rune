export interface Group {
  parents: string[];
  rules: Record<string, boolean>;
  weight?: number;
  profile?: Access;
}

export interface Context { server?: string; world?: string }
export interface Scoped { context?: Context; expiresAt?: number }
export interface Grant extends Scoped { group: string }
export interface Rule extends Scoped { node: string; allow: boolean }
export interface Label extends Scoped { text: string; priority: number }
export interface Access { rules?: Rule[]; prefix?: Label[]; suffix?: Label[] }
export interface PlayerAccess extends Access { grants?: Grant[]; primary?: string }
export interface Audit { actor: string; action: string; at: number }

export interface PermissionState {
  groups: Record<string, Group>;
  members: Record<string, string[]>;
  players?: Record<string, PlayerAccess>;
  tracks?: Record<string, string[]>;
  audit?: Audit[];
}

export const emptyGroup = (): Group => ({ parents: [], rules: {} });
export const initial = (): PermissionState => ({ groups: { default: emptyGroup() }, members: {} });

export function matchesScope(value: Scoped, context: Context, now: number) {
  return (value.expiresAt === undefined || value.expiresAt > now) &&
    (!value.context?.server || value.context.server === context.server) &&
    (!value.context?.world || value.context.world === context.world);
}

export function scopeKey(context?: Context) {
  return JSON.stringify([context?.server ?? "", context?.world ?? ""]);
}

export function replaceWhere<T>(values: readonly T[] | undefined, match: (value: T) => boolean, replacement?: T): T[] {
  const kept = (values ?? []).filter((value) => !match(value));
  if (replacement !== undefined) kept.push(replacement);
  return kept;
}

export function reachable(groups: ReadonlyMap<string, Group>, roots: readonly string[]): Set<string> {
  const visited = new Set<string>();
  const todo = [...roots];
  while (todo.length) {
    const id = todo.pop()!;
    const group = groups.get(id);
    if (!group || visited.has(id)) continue;
    visited.add(id);
    todo.push(...group.parents);
  }
  return visited;
}

export function rulesFor(groups: ReadonlyMap<string, Group>, memberships: readonly string[]) {
  const permissions = new Map<string, boolean>();
  for (const id of reachable(groups, ["default", ...memberships])) {
    for (const [node, allowed] of Object.entries(groups.get(id)!.rules)) {
      if (!allowed || !permissions.has(node)) permissions.set(node, allowed);
    }
  }
  return permissions;
}

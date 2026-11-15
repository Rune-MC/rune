export interface Group {
  parents: string[];
  rules: Record<string, boolean>;
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

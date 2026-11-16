export const corePermissions = {
  "overview:view": "Overview and process metrics",
  "server:view": "Paper, Bukkit, and world details",
  "players:view": "Online players and player directory",
  "runes:view": "Installed Runes and callback totals",
  "logs:view": "Rune logs and errors",
  "settings:view": "View Rune settings",
  "settings:edit": "Edit Rune settings",
  "server:reload": "Reload all Runes",
  "activity:view": "Dashboard audit activity",
} as const;

export type Permission = keyof typeof corePermissions | `tool:${string}:${"view" | "run"}` | `tool:${string}:action:${string}`;
export type Role = { id: string; name: string; permissions: Permission[] };
export const toolPermission = (id: string, action: "view" | "run"): Permission => `tool:${id}:${action}`;
const actionPermission = (id: string, action: string): Permission => `tool:${id}:action:${action}`;
export const canRunAction = (allows: (permission: Permission) => boolean, id: string, action: string) =>
  allows(toolPermission(id, "run")) || allows(actionPermission(id, action));
const monitoring = ["overview:view", "server:view", "players:view", "runes:view"] satisfies Permission[];
export const builtInRoles: readonly Role[] = [
  { id: "viewer", name: "Viewer", permissions: monitoring },
  { id: "moderator", name: "Moderator", permissions: ["overview:view", "players:view", toolPermission("moderation", "run")] },
  { id: "operator", name: "Operator", permissions: [...monitoring, "logs:view", "settings:edit", "server:reload", "activity:view"] },
];

export function permissionsFor(roles: readonly Role[], assigned: readonly string[]) {
  const result = new Set(roles.filter((role) => assigned.includes(role.id)).flatMap(({ permissions }) => permissions));
  if (result.has("settings:edit")) result.add("settings:view");
  if (result.has("server:reload")) result.add("server:view");
  for (const permission of result) {
    const [scope, id, action] = permission.split(":");
    if (scope === "tool" && (action === "run" || action === "action")) result.add(toolPermission(id, "view"));
  }
  return result;
}

export type AccessTool = { id: string; title: string; actions: ReadonlyMap<string, { title: string }> };
export const permissionLabels = (tools: Iterable<AccessTool>) => ({
  ...corePermissions,
  ...Object.fromEntries([...tools].flatMap(({ id, title, actions }) => [
    [toolPermission(id, "view"), `${title} · View pages`],
    ...(actions.size ? [[toolPermission(id, "run"), `${title} · Run all actions`],
      ...[...actions].map(([action, spec]) => [actionPermission(id, action), `${title} · ${spec.title}`])] : []),
  ])),
}) as Record<Permission, string>;

import { kinds } from "./model.ts";
import { backend } from "./platform.ts";

const suffixes = [
  "use", "admin", "immune", "notify", "revoke", "reports", "chat", "staffchat",
  "chat-bypass", "lockdown", "join-bypass", "teleport", "audit", ...kinds,
];
const registered = new Set<string>();

function registerNodes() {
  const manager = rune.bukkit.getPluginManager();
  const variable = Object.keys(backend.value().channels).map((id) => "channel." + id);
  let changed = false;
  for (const suffix of [...suffixes, ...variable]) {
    const name = "rune.moderation." + suffix;
    if (registered.has(name)) continue;
    if (!manager.getPermission(name)) {
      const permission = bukkit.permissions.PermissionDefault[suffix === "use" ? "OP" : "FALSE"];
      manager.addPermission(new bukkit.permissions.Permission(name, "Rune Moderation " + suffix, permission));
      changed = true;
    }
    registered.add(name);
  }
  if (changed) rune.services.get<{ refresh(): void }>("permissions", 1)?.refresh?.();
}

rune.schedule.nextTick(registerNodes);
backend.onChange(registerNodes);

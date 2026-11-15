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
  for (const suffix of [...suffixes, ...variable]) {
    const name = "rune.moderation." + suffix;
    if (registered.has(name)) continue;
    if (!manager.getPermission(name)) {
      manager.addPermission(new bukkit.permissions.Permission(name, "Rune Moderation " + suffix, suffix === "use" ? "OP" : "FALSE"));
    }
    registered.add(name);
  }
}

rune.schedule.nextTick(registerNodes);
backend.onChange(registerNodes);

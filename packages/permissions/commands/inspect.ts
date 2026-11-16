import { concreteNodes, contexts, playerNames } from "./suggestions.ts";
import { backend } from "../backend.ts";
import { resolveProfile } from "../resolve.ts";
import { server } from "../settings.ts";
import { permit, parseContext, permissionNode, target } from "./shared.ts";

@Command("permissions inspect", permit("inspect"))
export class Inspect {
  @Arg("target", { type: "player" }) target!: Player | null;
  @Run run({ sender }: CommandCtx) {
    if (!this.target) return;
    const value = resolveProfile(backend.value(), String(this.target.getUniqueId()), {
      server, world: this.target.getWorld().getName(),
    });
    sender.sendMessage(`Primary: ${value.primary}. Groups: ${value.groups.join(", ")}.`);
    sender.sendMessage(`Prefix: ${value.style("prefix")[0] ?? "(none)"} | Suffix: ${value.style("suffix")[0] ?? "(none)"}`);
  }
}

@Command("permissions explain", permit("explain"))
export class Explain {
  @Arg("player", { type: "word", suggest: playerNames }) player!: string;
  @Arg("node", { type: "string", suggest: concreteNodes }) node!: string;
  @Arg("context", { type: "string", suggest: contexts, optional: true }) context?: string;
  @Run run({ sender }: CommandCtx) {
    const who = target(this.player);
    if (!who) { sender.sendMessage("Use a known player name or UUID."); return; }
    try {
      const node = permissionNode(this.node);
      if (node.endsWith("*")) { sender.sendMessage("Specify a concrete permission to explain."); return; }
      const context = parseContext(this.context);
      const value = resolveProfile(backend.value(), who.id, { server, world: who.world, ...context }).explain(node);
      sender.sendMessage(value
        ? `${node}: ${value.allowed ? "allow" : "deny"} via ${value.source} (${value.node}).`
        : `Rune has no rule for ${node}. Bukkit or other plugins determine the result.`);
    } catch (error) {
      if (error instanceof Error) sender.sendMessage(error.message);
      else throw error;
    }
  }
}

@Command("permissions audit", permit("audit"))
export class AuditLog {
  @Arg("limit", { type: "int", min: 1, max: 50, optional: true, suggest: ["5", "10", "20", "50"] }) limit?: number;
  @Run run({ sender }: CommandCtx) {
    const rows = (backend.value().audit ?? []).slice(-(this.limit ?? 10)).reverse();
    if (!rows.length) sender.sendMessage("No permission changes recorded.");
    for (const row of rows) sender.sendMessage(`${new Date(row.at).toISOString()} ${row.actor} — ${row.action}`);
  }
}

import { createCooldowns } from "@rune/cooldowns";
import { details, editReport, fail, recordReport, type Identity } from "./model.ts";
import { actor, backend, identity, requirePermission, settings } from "./platform.ts";
import { feedback, informStaff } from "./cases.ts";

const throttle = createCooldowns();
export function report(player: Player, target: Identity, description: string) {
  const reporter = identity(player);
  const reason = details(description);
  const time = throttle.tryStart(reporter.id, Math.floor(settings.read()["report-cooldown-seconds"] * 1_000));
  if (!time.allowed) fail(`Try reporting again in ${Math.ceil(time.retryAfterMs / 1_000) || 1}s.`);
  const { done, reject } = feedback(player);
  const at = Date.now();
  backend.edit((state) => recordReport(state, { target, reporter, reason, at }), (entry) => {
    informStaff(`[Moderation] Report #${entry.id} from ${reporter.name} about ${target.name}.`);
    void rune.events.emit("moderation.report.updated", entry);
    done(`Report #${entry.id} submitted.`);
  }, (message) => { throttle.clear(reporter.id); reject(message); });
}

export function review(sender: CommandSender, id: number, action: "claim" | "resolve" | "reopen", reason?: string,
  done = feedback(sender).done, reject = feedback(sender).reject) {
  requirePermission(sender, "reports");
  const staff = actor(sender);
  const at = Date.now();
  backend.edit((state) => editReport(state, id, staff, action, at, reason), (entry) => {
    void rune.events.emit("moderation.report.updated", entry);
    done(`Report #${id}: ${action === "reopen" ? "reopened" : action === "resolve" ? "resolved" : "claimed"}.`);
  }, reject);
}

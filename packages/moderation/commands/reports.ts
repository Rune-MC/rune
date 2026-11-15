import { tell } from "@rune/paper-ui";
import { fail, type Report } from "../model.ts";
import { backend, mod, person, requirePermission } from "../platform.ts";
import { report, review } from "../reports.ts";
import { inGame, pageArg, playerNames, positiveId, printPage, run } from "./common.ts";

const line = (r: Report) => `#${r.id} • ${r.target.name} • ${r.resolved ? "Resolved" : r.assigned ? "Claimed by " + r.assigned.name : "Unclaimed"} • ${r.reason}`;
function list(sender: CommandSender, closed: boolean, page?: number) {
  requirePermission(sender, "reports");
  printPage(sender, closed ? "Resolved reports" : "Open reports", [...backend.value().reports].reverse()
    .filter((r) => Boolean(r.resolved) === closed).map(line), page);
}

@Command("report", { description: "Privately report a player to moderators" })
export class ReportPlayer {
  @Arg("target", { type: "word", suggest: playerNames }) target!: string;
  @Arg("reason", { type: "greedy" }) reason!: string;
  @Run run({ sender }: CommandCtx) { run(sender, () => report(inGame(sender), person(this.target), this.reason)); }
}

@Command("mod reports", mod)
export class OpenReports {
  @Arg("page", pageArg) page?: number;
  @Run run({ sender }: CommandCtx) { run(sender, () => list(sender, false, this.page)); }
}

@Command("mod reports closed", mod)
export class ClosedReports {
  @Arg("closed-page", pageArg) page?: number;
  @Run run({ sender }: CommandCtx) { run(sender, () => list(sender, true, this.page)); }
}

@Command("mod report", mod)
export class ShowReport {
  @Arg("report-id", positiveId) id!: number;
  @Run run({ sender }: CommandCtx) {
    run(sender, () => {
      requirePermission(sender, "reports");
      const item = backend.value().reports.find((r) => r.id === this.id) ?? fail("Report not found.");
      tell(sender, line(item));
      tell(sender, `Reported by ${item.reporter.name} • ${new Date(item.at).toISOString()}`);
      if (item.resolved) tell(sender, `Resolved by ${item.resolved.actor.name}: ${item.resolved.reason}`);
    });
  }
}

@Command("mod report claim", mod)
export class ClaimReport {
  @Arg("case", positiveId) id!: number;
  @Run run({ sender }: CommandCtx) { run(sender, () => review(sender, this.id, "claim")); }
}

@Command("mod report resolve", mod)
export class ResolveReport {
  @Arg("case", positiveId) id!: number;
  @Arg("resolution", { type: "greedy" }) reason!: string;
  @Run run({ sender }: CommandCtx) { run(sender, () => review(sender, this.id, "resolve", this.reason)); }
}

@Command("mod report reopen", mod)
export class ReopenReport {
  @Arg("case", positiveId) id!: number;
  @Run run({ sender }: CommandCtx) { run(sender, () => review(sender, this.id, "reopen")); }
}

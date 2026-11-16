import { activeId, undo } from "../cases.ts";
import { ipAddress, mod, person } from "../platform.ts";
import { activeTargets, caseIds, positiveId, revokeReasons, run } from "./common.ts";

@Command("mod unban", mod)
export class Unban {
  @Arg("target", { type: "word", suggest: activeTargets("ban") }) target!: string;
  @Arg("reason", { type: "greedy", suggest: revokeReasons }) reason!: string;
  @Run run({ sender }: CommandCtx) {
    run(sender, () => undo(sender, activeId("ban", person(this.target).id), this.reason));
  }
}

@Command("mod unmute", mod)
export class Unmute {
  @Arg("target", { type: "word", suggest: activeTargets("mute") }) target!: string;
  @Arg("reason", { type: "greedy", suggest: revokeReasons }) reason!: string;
  @Run run({ sender }: CommandCtx) {
    run(sender, () => undo(sender, activeId("mute", person(this.target).id), this.reason));
  }
}

@Command("mod unfreeze", mod)
export class Unfreeze {
  @Arg("target", { type: "word", suggest: activeTargets("freeze") }) target!: string;
  @Arg("reason", { type: "greedy", suggest: revokeReasons }) reason!: string;
  @Run run({ sender }: CommandCtx) {
    run(sender, () => undo(sender, activeId("freeze", person(this.target).id), this.reason));
  }
}

@Command("mod unipban", mod)
export class Unipban {
  @Arg("target", { type: "string", suggest: activeTargets("ipban") }) target!: string;
  @Arg("reason", { type: "greedy", suggest: revokeReasons }) reason!: string;
  @Run run({ sender }: CommandCtx) {
    run(sender, () => undo(sender, activeId("ipban", ipAddress(this.target)), this.reason));
  }
}

@Command("mod revoke", mod)
export class Revoke {
  @Arg("case", { ...positiveId, suggest: caseIds(true) }) id!: number;
  @Arg("reason", { type: "greedy", suggest: revokeReasons }) reason!: string;
  @Run run({ sender }: CommandCtx) { run(sender, () => undo(sender, this.id, this.reason)); }
}

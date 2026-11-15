import { issue } from "../cases.ts";
import { mod, person } from "../platform.ts";
import { address, durationPresets, playerNames, run } from "./common.ts";

@Command("mod ban", mod)
export class Ban {
  @Arg("target", { type: "word", suggest: playerNames }) target!: string;
  @Arg("duration", { type: "string", suggest: durationPresets }) duration!: string;
  @Arg("reason", { type: "greedy" }) reason!: string;
  @Run run({ sender }: CommandCtx) {
    run(sender, () => issue(sender, "ban", person(this.target), this.reason, this.duration));
  }
}

@Command("mod mute", mod)
export class Mute {
  @Arg("target", { type: "word", suggest: playerNames }) target!: string;
  @Arg("duration", { type: "string", suggest: durationPresets }) duration!: string;
  @Arg("reason", { type: "greedy" }) reason!: string;
  @Run run({ sender }: CommandCtx) {
    run(sender, () => issue(sender, "mute", person(this.target), this.reason, this.duration));
  }
}

@Command("mod freeze", mod)
export class Freeze {
  @Arg("target", { type: "word", suggest: playerNames }) target!: string;
  @Arg("duration", { type: "string", suggest: durationPresets }) duration!: string;
  @Arg("reason", { type: "greedy" }) reason!: string;
  @Run run({ sender }: CommandCtx) {
    run(sender, () => issue(sender, "freeze", person(this.target), this.reason, this.duration));
  }
}

@Command("mod ipban", mod)
export class Ipban {
  @Arg("target", { type: "word" }) target!: string;
  @Arg("duration", { type: "string", suggest: durationPresets }) duration!: string;
  @Arg("reason", { type: "greedy" }) reason!: string;
  @Run run({ sender }: CommandCtx) {
    run(sender, () => issue(sender, "ipban", address(this.target), this.reason, this.duration));
  }
}

@Command("mod kick", mod)
export class Kick {
  @Arg("target", { type: "word", suggest: playerNames }) target!: string;
  @Arg("reason", { type: "greedy" }) reason!: string;
  @Run run({ sender }: CommandCtx) {
    run(sender, () => issue(sender, "kick", person(this.target), this.reason, "permanent"));
  }
}

@Command("mod warn", mod)
export class Warn {
  @Arg("target", { type: "word", suggest: playerNames }) target!: string;
  @Arg("reason", { type: "greedy" }) reason!: string;
  @Run run({ sender }: CommandCtx) {
    run(sender, () => issue(sender, "warn", person(this.target), this.reason, "permanent"));
  }
}

@Command("mod note", mod)
export class Note {
  @Arg("target", { type: "word", suggest: playerNames }) target!: string;
  @Arg("reason", { type: "greedy" }) reason!: string;
  @Run run({ sender }: CommandCtx) {
    run(sender, () => issue(sender, "note", person(this.target), this.reason, "permanent"));
  }
}

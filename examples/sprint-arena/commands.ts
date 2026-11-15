import { join, leave } from "./arena.ts";
import { point, state } from "./state.ts";

@Command("arena join", { description: "Queue for Sprint Arena" })
export class JoinArena {
  @Arg("party", { type: "word", optional: true }) party?: string;
  @Run run({ sender }: CommandCtx) { if (sender.isPlayer) join(sender as unknown as Player, this.party); }
}

@Command("arena leave")
export class LeaveArena {
  @Run run({ sender }: CommandCtx) { if (sender.isPlayer) leave(sender as unknown as Player); }
}

function setCheckpoint(sender: CommandCtx["sender"], checkpoint: "start" | "finish") {
  if (!sender.isPlayer) return;
  const saved = point((sender as unknown as Player).getLocation());
  state.edit((draft) => { draft[checkpoint] = saved; },
    () => sender.sendMessage(`Set the arena ${checkpoint}.`), (message) => sender.sendMessage(message));
}

@Command("arena set-start", { permission: "rune.admin" })
export class SetArenaStart {
  @Run run({ sender }: CommandCtx) { setCheckpoint(sender, "start"); }
}

@Command("arena set-finish", { permission: "rune.admin" })
export class SetArenaFinish {
  @Run run({ sender }: CommandCtx) { setCheckpoint(sender, "finish"); }
}

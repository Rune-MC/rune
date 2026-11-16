import { playerNames, trackOrder } from "./suggestions.ts";
import { backend } from "../backend.ts";
import { deleteTrack, moveTrack, setTrack } from "../changes.ts";
import { permit, edit, target, tracks } from "./shared.ts";

@Command("permissions tracks", permit("track.list"))
export class ListTracks {
  @Run run({ sender }: CommandCtx) {
    const rows = Object.entries(backend.value().tracks ?? {});
    if (!rows.length) sender.sendMessage("No promotion tracks.");
    for (const [name, order] of rows) sender.sendMessage(`${name}: ${order.join(" → ")}`);
  }
}

@Command("permissions track-set", permit("track.set"))
export class SetTrack {
  @Arg("track", { type: "word", suggest: tracks }) track!: string;
  @Arg("groups", { type: "greedy", suggest: trackOrder }) groups!: string;
  @Run run(ctx: CommandCtx) {
    edit(ctx, `Saved track ${this.track}.`, setTrack(this.track, this.groups.trim().split(/\s+/)));
  }
}

@Command("permissions track-delete", permit("track.delete"))
export class DeleteTrack {
  @Arg("track", { type: "word", suggest: tracks }) track!: string;
  @Run run(ctx: CommandCtx) {
    edit(ctx, `Deleted track ${this.track}.`, deleteTrack(this.track));
  }
}

function move(ctx: CommandCtx, input: string, track: string, step: 1 | -1) {
  const who = target(input);
  if (!who) { ctx.sender.sendMessage("Use a known player name or UUID."); return; }
  edit(ctx, `${step === 1 ? "Promoted" : "Demoted"} ${who.name} on ${track}.`, moveTrack(who.id, track, step));
}

@Command("permissions promote", permit("track.promote"))
export class Promote {
  @Arg("player", { type: "word", suggest: playerNames }) player!: string;
  @Arg("track", { type: "word", suggest: tracks }) track!: string;
  @Run run(ctx: CommandCtx) { move(ctx, this.player, this.track, 1); }
}

@Command("permissions demote", permit("track.demote"))
export class Demote {
  @Arg("player", { type: "word", suggest: playerNames }) player!: string;
  @Arg("track", { type: "word", suggest: tracks }) track!: string;
  @Run run(ctx: CommandCtx) { move(ctx, this.player, this.track, -1); }
}

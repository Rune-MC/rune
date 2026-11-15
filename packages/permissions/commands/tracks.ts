import { backend } from "../backend.ts";
import { admin, edit, fail, group, named, target, tracks } from "./shared.ts";

@Command("permissions tracks", admin)
export class ListTracks {
  @Run run({ sender }: CommandCtx) {
    const rows = Object.entries(backend.value().tracks ?? {});
    if (!rows.length) sender.sendMessage("No promotion tracks.");
    for (const [name, order] of rows) sender.sendMessage(`${name}: ${order.join(" → ")}`);
  }
}

@Command("permissions track-set", admin)
export class SetTrack {
  @Arg("track", { type: "word", suggest: tracks }) track!: string;
  @Arg("groups", { type: "greedy" }) groups!: string;
  @Run run(ctx: CommandCtx) {
    edit(ctx, `Saved track ${this.track}.`, (data) => {
      const steps = this.groups.trim().split(/\s+/).map((key) => group(data, key).id);
      if (steps.length > 32 || new Set(steps).size !== steps.length || steps.includes("default")) {
        fail("Use up to 32 different groups excluding default.");
      }
      (data.tracks ??= {})[named(this.track)] = steps;
    });
  }
}

@Command("permissions track-delete", admin)
export class DeleteTrack {
  @Arg("track", { type: "word", suggest: tracks }) track!: string;
  @Run run(ctx: CommandCtx) {
    edit(ctx, `Deleted track ${this.track}.`, (data) => {
      const key = named(this.track);
      if (!Object.hasOwn(data.tracks ?? {}, key)) fail("Unknown promotion track.");
      delete data.tracks![key];
    });
  }
}

function move(ctx: CommandCtx, input: string, track: string, step: 1 | -1) {
  const who = target(input);
  if (!who) { ctx.sender.sendMessage("Use an online player name or an offline UUID."); return; }
  edit(ctx, `${step === 1 ? "Promoted" : "Demoted"} ${who.name} on ${track}.`, (data) => {
    const name = named(track);
    const steps = Object.hasOwn(data.tracks ?? {}, name) ? data.tracks![name] : undefined;
    if (!steps?.length) fail("Unknown promotion track.");
    const prior = new Set(data.members[who.id] ?? []);
    const old = steps.findLastIndex((value) => prior.has(value));
    if ((step === -1 && old === -1) || (step === 1 && old === steps.length - 1)) fail("Player is already at the end of this track.");
    for (const oldRank of steps) prior.delete(oldRank);
    const destination = steps[old + step];
    if (destination) prior.add(destination);
    if (prior.size) data.members[who.id] = [...prior];
    else delete data.members[who.id];
  });
}

@Command("permissions promote", admin)
export class Promote {
  @Arg("player", { type: "word" }) player!: string;
  @Arg("track", { type: "word", suggest: tracks }) track!: string;
  @Run run(ctx: CommandCtx) { move(ctx, this.player, this.track, 1); }
}

@Command("permissions demote", admin)
export class Demote {
  @Arg("player", { type: "word" }) player!: string;
  @Arg("track", { type: "word", suggest: tracks }) track!: string;
  @Run run(ctx: CommandCtx) { move(ctx, this.player, this.track, -1); }
}

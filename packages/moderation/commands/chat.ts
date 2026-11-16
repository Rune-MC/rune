import { tell } from "@rune/paper-ui";
import { canAccess, channelList, chooseChannel, clearChat, routeChat, setLock, setSlow, writeChannel } from "../chat.ts";
import { fail } from "../model.ts";
import { backend, can, mod } from "../platform.ts";
import { durationPresets, inGame, run, slowModePresets } from "./common.ts";

const channelsFor = (action: "join" | "focus" | "leave" | "send") =>
  (_partial: string, { sender }: CommandSuggestionContext) => {
    if (!sender.isPlayer) return [];
    return channelList(sender as unknown as Player).filter((channel) => {
      if (action === "leave") return channel.id !== "global" && channel.joined;
      if (action === "send") return channel.id !== "global";
      return true;
    }).map(({ id }) => id);
  };
const customChannels = (_partial: string, { sender }: CommandSuggestionContext) =>
  can(sender, "chat") ? Object.keys(backend.value().channels).sort() : [];
const channelName = (_partial: string, ctx: CommandSuggestionContext) => {
  if (!can(ctx.sender, "chat")) return [];
  const id = String(ctx.args.channel ?? "").toLowerCase();
  const channels = backend.value().channels;
  return Object.hasOwn(channels, id) ? [channels[id].name] : [];
};
const chatReasons = ["Spam", "Harassment", "Staff review", "Server maintenance"];

@Command("channel", { description: "List and join chat channels" })
export class Channels {
  @Run run({ sender }: CommandCtx) {
    run(sender, () => {
      const player = inGame(sender);
      for (const value of channelList(player)) tell(player, `${value.id} • ${value.name} • ${value.focused ? "Focused" : value.joined ? "Listening" : "Available"}`);
      tell(player, "/channel join <id> • /channel focus <id> • /channel leave <id> • /channel gui", "gray");
    });
  }
}

@Command("channel join")
export class ChannelJoin {
  @Arg("channel", { type: "word", suggest: channelsFor("join") }) channel!: string;
  @Run run({ sender }: CommandCtx) { run(sender, () => chooseChannel(inGame(sender), this.channel, "join")); }
}

@Command("channel leave")
export class ChannelLeave {
  @Arg("channel", { type: "word", suggest: channelsFor("leave") }) channel!: string;
  @Run run({ sender }: CommandCtx) { run(sender, () => chooseChannel(inGame(sender), this.channel, "leave")); }
}

@Command("channel focus")
export class ChannelFocus {
  @Arg("channel", { type: "word", suggest: channelsFor("focus") }) channel!: string;
  @Run run({ sender }: CommandCtx) { run(sender, () => chooseChannel(inGame(sender), this.channel, "focus")); }
}

@Command("channel send")
export class ChannelSend {
  @Arg("channel", { type: "word", suggest: channelsFor("send") }) channel!: string;
  @Arg("message", { type: "greedy" }) message!: string;
  @Run run({ sender }: CommandCtx) {
    run(sender, () => {
      const target = this.channel.toLowerCase();
      if (target === "global") fail("Focus global and send a regular chat message.");
      routeChat(inGame(sender), this.message, target);
    });
  }
}

@Command("staffchat", { description: "Send a message to the staff channel" })
export class StaffChat {
  @Arg("message", { type: "greedy" }) message!: string;
  @Run run({ sender }: CommandCtx) {
    run(sender, () => {
      const player = inGame(sender);
      if (!canAccess(player, "staff")) fail("Requires rune.moderation.staffchat.");
      routeChat(player, this.message, "staff");
    });
  }
}

@Command("mod chat slow", mod)
export class SlowChat {
  @Arg("seconds", { type: "int", min: 0, max: 600, suggest: slowModePresets }) seconds!: number;
  @Run run({ sender }: CommandCtx) { run(sender, () => setSlow(sender, this.seconds)); }
}

@Command("mod chat lock", mod)
export class LockChat {
  @Arg("duration", { type: "string", suggest: durationPresets }) duration!: string;
  @Arg("reason", { type: "greedy", suggest: chatReasons }) reason!: string;
  @Run run({ sender }: CommandCtx) { run(sender, () => setLock(sender, "locked", this.duration, this.reason)); }
}

@Command("mod chat unlock", mod)
export class UnlockChat {
  @Run run({ sender }: CommandCtx) { run(sender, () => setLock(sender, "locked")); }
}

@Command("mod chat clear", mod)
export class ClearChat {
  @Arg("reason", { type: "greedy", suggest: chatReasons }) reason!: string;
  @Run run({ sender }: CommandCtx) { run(sender, () => clearChat(sender, this.reason)); }
}

@Command("mod chat channel set", mod)
export class SetChannel {
  @Arg("channel", { type: "word", suggest: customChannels }) channel!: string;
  @Arg("restricted", { type: "bool" }) restricted!: boolean;
  @Arg("seconds", { type: "int", min: 0, max: 600, suggest: slowModePresets }) seconds!: number;
  @Arg("name", { type: "greedy", suggest: channelName }) name!: string;
  @Run run({ sender }: CommandCtx) {
    run(sender, () => writeChannel(sender, this.channel, { name: this.name, restricted: this.restricted, slowSeconds: this.seconds }));
  }
}

@Command("mod chat channel delete", mod)
export class RemoveChannel {
  @Arg("channel", { type: "word", suggest: customChannels }) channel!: string;
  @Run run({ sender }: CommandCtx) { run(sender, () => writeChannel(sender, this.channel, undefined)); }
}

@Command("mod lockdown", mod)
export class LockServer {
  @Arg("duration", { type: "string", suggest: durationPresets }) duration!: string;
  @Arg("reason", { type: "greedy", suggest: chatReasons }) reason!: string;
  @Run run({ sender }: CommandCtx) { run(sender, () => setLock(sender, "lockdown", this.duration, this.reason)); }
}

@Command("mod unlock", mod)
export class UnlockServer {
  @Run run({ sender }: CommandCtx) { run(sender, () => setLock(sender, "lockdown")); }
}

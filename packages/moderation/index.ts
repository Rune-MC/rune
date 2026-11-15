import "./enforcement.ts";
import "./roles.ts";
import "./commands/cases.ts";
import "./commands/punish.ts";
import "./commands/revoke.ts";
import "./commands/reports.ts";
import "./commands/chat.ts";

import { channelGui, reportGui } from "./gui/public.ts";
import { inGame, run } from "./commands/common.ts";
import { banFor, punishment } from "./platform.ts";

@Command("channel gui")
export class ChannelMenu {
  @Run run({ sender }: CommandCtx) { run(sender, () => channelGui(inGame(sender))); }
}

@Command("report gui")
export class ReportMenu {
  @Run run({ sender }: CommandCtx) { run(sender, () => reportGui(inGame(sender))); }
}

rune.services.provide("moderation", 1, {
  active: punishment,
  ban: banFor,
});

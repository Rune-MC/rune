import "./enforcement.ts";
import "./roles.ts";
import "./commands/cases.ts";
import "./commands/punish.ts";
import "./commands/revoke.ts";
import "./commands/reports.ts";
import "./commands/chat.ts";

import { channelGui, reportGui } from "./gui/public.ts";
import { chatSettings } from "./gui/chat.ts";
import { inGame, run } from "./commands/common.ts";
import { banFor, can, punishment } from "./platform.ts";
import { channels } from "./chat.ts";

rune.dashboard?.whenInstalled?.(async () => {
  if (!(rune.dashboard.apiVersion >= 2)) return;
  return (await import("./dashboard.ts")).registerDashboard();
});

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

rune.services.provide("moderation-channels", 1, {
  list: () => Object.entries(channels()).map(([id, channel]) => ({ id, name: channel.name })),
  canManage: (player: Player) => can(player, "use") && can(player, "chat"),
  openSettings: (player: Player, back: (player: Player) => void) => {
    if (can(player, "use") && can(player, "chat")) chatSettings(back)(player);
  },
});

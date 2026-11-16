import { issue, undo } from "./cases.ts";
import { clearChat, setLock, setSlow, writeChannel } from "./chat.ts";
import { address } from "./commands/common.ts";
import { durationHelp } from "./duration.ts";
import { fail, kinds, type Kind } from "./model.ts";
import { online, person, requirePermission } from "./platform.ts";
import { review } from "./reports.ts";

const reason = { type: "string", required: true, multiline: true, maxLength: 240 } as const;
const id = { type: "number", required: true, min: 1, max: Number.MAX_SAFE_INTEGER } as const;
const channel = { type: "string", label: "Channel ID", required: true, maxLength: 24 } as const;
const slow = { type: "number", label: "Seconds between messages (0 disables)", required: true, min: 0, max: 600 } as const;
const duration = { type: "string", default: "permanent", maxLength: 50, description: durationHelp } as const;
const run = (operation: (sender: CommandSender, done: (message: string) => void, reject: (message: string) => void) => void) =>
  new Promise<string>((resolve, reject) => operation(rune.bukkit.getConsoleSender(), resolve, (error) => reject(new Error(error))));
function caseId(value: RuneDashboardValue) {
  if (!Number.isSafeInteger(value)) throw new Error("Enter a whole case or report ID.");
  return Number(value);
}

export const moderationActions = {
  "issue-case": {
    title: "Issue moderation action", confirm: "Apply this action to the selected target",
    fields: {
      kind: { type: "string", label: "Action", required: true, choices: Object.fromEntries(kinds.map((kind) => [kind, kind.toUpperCase()])) },
      target: { type: "string", label: "Player name, UUID, or IP address for IP bans", required: true, maxLength: 64 },
      reason, duration: { ...duration, label: "Duration for bans, mutes, and freezes" },
    },
    run: (input) => run((sender, done, reject) => {
      const kind = input.kind as Kind;
      const target = kind === "ipban" ? address(String(input.target), true) : person(String(input.target));
      issue(sender, kind, target, String(input.reason), String(input.duration || "permanent"), done, reject);
    }),
  },
  "revoke-case": {
    title: "Revoke punishment", confirm: "Lift the active punishment", fields: { case: { ...id, label: "Case ID" }, reason },
    run: (input) => run((sender, done, reject) => undo(sender, caseId(input.case), String(input.reason), done, reject)),
  },
  "teleport-staff": {
    title: "Teleport staff to player", confirm: "Move the selected staff member to this player",
    fields: {
      staff: { type: "string", label: "Online staff name or UUID", required: true, maxLength: 36 },
      target: { type: "string", label: "Destination player name or UUID", required: true, maxLength: 36 },
    },
    run(input) {
      const staff = online(person(String(input.staff)).id) ?? fail("The staff member must be online.");
      requirePermission(staff as unknown as CommandSender, "teleport");
      const target = online(person(String(input.target)).id) ?? fail("The destination player must be online.");
      if (!staff.teleport(target.getLocation())) fail("Paper denied the teleport.");
      return `Teleported ${staff.getName()} to ${target.getName()}.`;
    },
  },
  "review-report": {
    title: "Review player report",
    fields: {
      report: { ...id, label: "Report ID" }, operation: { type: "string", required: true, choices: { claim: "Claim", resolve: "Resolve", reopen: "Reopen" } },
      reason: { ...reason, required: false, description: "Include a resolution when closing a report." },
    },
    run: (input) => run((sender, done, reject) => review(sender, caseId(input.report), input.operation as Parameters<typeof review>[2],
      input.reason ? String(input.reason) : undefined, done, reject)),
  },
  "save-channel": {
    title: "Save chat channel",
    fields: { channel, name: { type: "string", required: true, maxLength: 32 }, delay: slow,
      restricted: { type: "boolean", label: "Require the channel permission to join" } },
    run: (input) => run((sender, done, reject) => writeChannel(sender, String(input.channel),
      { name: String(input.name), restricted: input.restricted === true, slowSeconds: Number(input.delay) }, done, reject)),
  },
  "delete-channel": {
    title: "Delete chat channel", confirm: "Remove this custom channel", fields: { channel },
    run: (input) => run((sender, done, reject) => writeChannel(sender, String(input.channel), undefined, done, reject)),
  },
  "slow-mode": {
    title: "Set global slow mode", fields: { seconds: slow },
    run: (input) => run((sender, done, reject) => setSlow(sender, Number(input.seconds), done, reject)),
  },
  "set-lock": {
    title: "Set chat lock or join lockdown", confirm: "Apply this policy to the server",
    fields: {
      policy: { type: "string", required: true, choices: { locked: "Lock public chat", lockdown: "Lock down server joins" } },
      enabled: { type: "boolean", label: "Enable policy" }, duration,
      reason: { ...reason, required: false, description: "Required when enabling the policy." },
    },
    run: (input) => run((sender, done, reject) => setLock(sender, input.policy === "locked" ? "locked" : "lockdown",
      input.enabled ? String(input.duration || "permanent") : undefined, String(input.reason ?? ""), done, reject)),
  },
  "clear-chat": {
    title: "Clear chat", confirm: "Clear recent public chat for online players", fields: { reason },
    run: (input) => run((sender, done, reject) => clearChat(sender, String(input.reason), done, reject)),
  },
} satisfies NonNullable<RuneDashboardContribution["actions"]>;

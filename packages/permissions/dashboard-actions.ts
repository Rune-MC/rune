import { createGroup, deleteGroup, deleteTrack, grant, groupWeight, inherit, moveTrack, primary, setLabel, setRule, setTrack, type Subject } from "./changes.ts";
import { preview, saveFormat, scopes, setEnabled } from "./chat-format.ts";
import { commit, expiry, fail, parseContext, permissionNode, target } from "./commands/shared.ts";

const group = { type: "string", required: true, maxLength: 32 } as const;
const player = { type: "string", player: "known", label: "Player", required: true, maxLength: 36 } as const;
const subjectField = (kind: Subject["type"]) => kind === "player" ? player : { ...group, label: "Group ID" };
const scope = {
  context: { type: "string", label: "Context", description: "Use global, world=name, server=name, or server=name,world=name.", maxLength: 180 },
  duration: { type: "string", label: "Duration", description: "Use 30m, 2h, 7d, or permanent.", maxLength: 12 },
} as const;
type Done = () => void;
type Reject = (message: string) => void;
const consoleSender = () => rune.bukkit.getConsoleSender();
const save = (message: string, change: Parameters<typeof commit>[2]) =>
  complete(message, (done, reject) => commit(consoleSender(), message, change, done, reject));
const complete = (message: string, run: (done: Done, reject: Reject) => void) =>
  new Promise<string>((resolve, reject) => run(() => resolve(message), (error) => reject(new Error(error))));
const playerId = (name: RuneDashboardValue) => target(String(name))?.id ?? fail("Unknown player.");
const whole = (value: RuneDashboardValue) => Number.isSafeInteger(value) ? Number(value) : fail("Enter a whole number.");
const holder = (kind: Subject["type"], name: RuneDashboardValue): Subject =>
  kind === "group" ? { type: "group", id: String(name) } : { type: "player", id: playerId(name) };
type Action = NonNullable<RuneDashboardContribution["actions"]>[string];

function rule(kind: Subject["type"]): Action {
  return {
    title: `Edit ${kind} permission rule`,
    fields: { subject: subjectField(kind), node: { type: "string", required: true, maxLength: 128 },
      decision: { type: "string", required: true, choices: { allow: "Allow", deny: "Deny", unset: "Remove rule" } }, ...scope },
    run(input) {
      const node = permissionNode(String(input.node));
      const context = parseContext(String(input.context ?? ""));
      const value = input.decision === "unset" ? undefined : { node, context, allow: input.decision === "allow", expiresAt: expiry(String(input.duration ?? "")) };
      return save(`Updated ${node} for ${input.subject}.`, setRule(holder(kind, input.subject), node, context, value));
    },
  };
}

function decoration(kind: Subject["type"]): Action {
  return {
    title: `Edit ${kind} prefix or suffix`,
    fields: { subject: subjectField(kind), label: { type: "string", required: true, choices: { prefix: "Prefix", suffix: "Suffix" } },
      priority: { type: "number", required: true, min: -100000, max: 100000 },
      text: { type: "string", label: "MiniMessage text", description: "Leave blank to remove the label at this priority and context.", maxLength: 160 }, ...scope },
    run(input) {
      const text = String(input.text ?? "");
      if (text) rune.adventure.miniMessage(text);
      const labelKind = input.label === "suffix" ? "suffix" : "prefix";
      const priority = whole(input.priority);
      const context = parseContext(String(input.context ?? ""));
      const label = text ? { text, priority, context, expiresAt: expiry(String(input.duration ?? "")) } : undefined;
      return save(`Updated ${labelKind} for ${input.subject}.`, setLabel(holder(kind, input.subject), labelKind, priority, context, label));
    },
  };
}

export const permissionActions = {
  "create-group": {
    title: "Create group", fields: { group }, run: (input) => save(`Created group ${input.group}.`, createGroup(String(input.group))),
  },
  "delete-group": {
    title: "Delete group", confirm: "Remove the group and its grants, inheritance links, and track entries",
    fields: { group }, run: (input) => save(`Deleted group ${input.group}.`, deleteGroup(String(input.group))),
  },
  weight: {
    title: "Set group weight", fields: { group, weight: { type: "number", required: true, min: -100000, max: 100000 } },
    run: (input) => save(`Updated ${input.group} weight.`, groupWeight(String(input.group), whole(input.weight))),
  },
  inheritance: {
    title: "Edit group inheritance",
    fields: { group, parent: group, operation: { type: "string", required: true, choices: { add: "Add parent", remove: "Remove parent" } } },
    run: (input) => save(`Updated inheritance for ${input.group}.`, inherit(String(input.group), String(input.parent), input.operation === "add")),
  },
  "group-rule": rule("group"),
  "player-rule": rule("player"),
  "group-decoration": decoration("group"),
  "player-decoration": decoration("player"),
  membership: {
    title: "Grant or revoke group",
    fields: { player, group, operation: { type: "string", required: true, choices: { grant: "Grant group", revoke: "Revoke grant" } }, ...scope },
    run(input) {
      const revoke = input.operation === "revoke";
      return save(`Updated groups for ${input.player}.`, grant(playerId(input.player), String(input.group), parseContext(String(input.context ?? "")),
        revoke ? undefined : expiry(String(input.duration ?? "")), revoke));
    },
  },
  primary: {
    title: "Set primary group", fields: { player, group: { ...group, required: false, description: "Leave blank to select the primary group by weight." } },
    run: (input) => save(`Updated primary group for ${input.player}.`, primary(playerId(input.player), input.group ? String(input.group) : undefined)),
  },
  "save-track": {
    title: "Save promotion track",
    fields: { track: group, groups: { type: "string", label: "Groups in promotion order", description: "Separate group IDs with commas.", required: true, maxLength: 1100 } },
    run: (input) => save(`Saved track ${input.track}.`, setTrack(String(input.track), String(input.groups).split(",").map((name) => name.trim()))),
  },
  "delete-track": {
    title: "Delete promotion track", confirm: "Remove this promotion track", fields: { track: group },
    run: (input) => save(`Deleted track ${input.track}.`, deleteTrack(String(input.track))),
  },
  "move-rank": {
    title: "Promote or demote player",
    fields: { player, track: group, direction: { type: "string", required: true, choices: { promote: "Promote", demote: "Demote" } } },
    run: (input) => save(`Updated ${input.player} on ${input.track}.`, moveTrack(playerId(input.player), String(input.track), input.direction === "promote" ? 1 : -1)),
  },
  format: {
    title: "Save chat format",
    fields: { scope: { type: "string", required: true, maxLength: 64 }, template: { type: "string", required: true, multiline: true, maxLength: 500 } },
    run: (input) => complete(`Saved format for ${input.scope}.`, (done, reject) => saveFormat(consoleSender(), String(input.scope), String(input.template), done, reject)),
  },
  "preview-format": {
    title: "Preview chat text",
    fields: { scope: { type: "string", required: true, maxLength: 64 }, template: { type: "string", required: true, multiline: true, maxLength: 500 },
      player: { ...player, player: "online", required: false, description: "Choose an online player to resolve their labels and PlaceholderAPI values." } },
    run(input) {
      const scope = String(input.scope);
      if (!scopes().includes(scope)) fail("Choose a listed chat scope.");
      const who = input.player ? rune.player(String(input.player)) ?? fail("Choose an online player for this preview.") : undefined;
      return rune.adventure.serialize(preview(scope, String(input.template), who), "plain");
    },
  },
  "reset-format": {
    title: "Reset chat format", confirm: "Restore the inherited format for this scope",
    fields: { scope: { type: "string", required: true, maxLength: 64 } },
    run: (input) => complete(`Reset format for ${input.scope}.`, (done, reject) => saveFormat(consoleSender(), String(input.scope), undefined, done, reject)),
  },
  "enable-formatting": {
    title: "Set chat formatting status", fields: { enabled: { type: "boolean", label: "Enable custom chat formatting" } },
    run: (input) => complete("Updated chat formatting.", (done, reject) => setEnabled(consoleSender(), input.enabled === true, done, reject)),
  },
} satisfies NonNullable<RuneDashboardContribution["actions"]>;

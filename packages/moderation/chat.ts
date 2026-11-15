import { tell, uuid } from "@rune/paper-ui";
import { expiry, remaining } from "./duration.ts";
import { audit, details, fail, inForce, type Channel, type ChatPolicy } from "./model.ts";
import { actor, backend, can, punishment, requirePermission, server } from "./platform.ts";
import { feedback, informStaff, playerNotice, type Done } from "./cases.ts";

const defaults: Record<string, Channel> = {
  global: { name: "Global", restricted: false, slowSeconds: 0 },
  staff: { name: "Staff", restricted: true, slowSeconds: 0 },
};
type Session = { focused: string; joined: Set<string>; last: Map<string, number> };
const sessions = new Map<string, Session>();

function session(player: Player) {
  const id = uuid(player);
  let current = sessions.get(id);
  if (!current) {
    current = { focused: "global", joined: new Set(["global", "staff"]), last: new Map() };
    sessions.set(id, current);
  }
  return current;
}

export const forgetChat = (player: Player) => sessions.delete(uuid(player));
export const policy = () => {
  const policies = backend.value().policies;
  return Object.hasOwn(policies, server) ? policies[server] : {};
};
export const channels = (): Record<string, Channel> => ({ ...backend.value().channels, ...defaults });
export const channelIds = () => Object.keys(channels()).sort();
function configuredChannel(id: string) {
  if (Object.hasOwn(defaults, id)) return defaults[id];
  const custom = backend.value().channels;
  return Object.hasOwn(custom, id) ? custom[id] : undefined;
}
export function canAccess(player: Player, id: string) {
  const value = configuredChannel(id);
  if (!value) return false;
  if (id === "staff") return can(player, "staffchat");
  return !value.restricted || can(player, "channel." + id);
}

export function channelList(player: Player) {
  const current = session(player);
  return Object.entries(channels()).sort(([a], [b]) => a.localeCompare(b))
    .filter(([id]) => canAccess(player, id)).map(([id, channel]) => ({
      id, ...channel, joined: current.joined.has(id), focused: current.focused === id,
    }));
}

export function chooseChannel(player: Player, input: string, action: "join" | "leave" | "focus") {
  const id = input.toLowerCase();
  if (id === "global" && action === "leave") fail("Global chat is always available. Focus a different channel to send there.");
  const current = session(player);
  if (action === "leave") {
    if (!current.joined.delete(id)) fail("You are not listening to that channel.");
    if (current.focused === id) current.focused = "global";
  } else {
    if (!canAccess(player, id)) fail("That channel is unavailable.");
    current.joined.add(id);
    if (action === "focus") current.focused = id;
  }
  tell(player, `${action === "leave" ? "Left" : action === "join" ? "Listening to" : "Sending chat to"} ${id}.`, "green");
}

export function muteMessage(player: Player) {
  const item = punishment("mute", uuid(player));
  return item && playerNotice(item);
}

/** Return true when the host should suppress the original message. */
export function routeChat(player: Player, text: string, forced?: string) {
  const muted = muteMessage(player);
  if (muted) { tell(player, muted, "red"); return true; }
  const current = session(player);
  let id = forced ?? current.focused;
  if (!canAccess(player, id)) {
    if (forced) { tell(player, "That channel is unavailable.", "red"); return true; }
    current.focused = id = "global";
  }
  const mode = policy();
  if (id !== "staff" && !can(player, "chat-bypass")) {
    if (mode.locked && inForce(mode.locked)) {
      tell(player, `Public chat is locked (${remaining(mode.locked.expiresAt)}). ${mode.locked.reason}`, "red");
      return true;
    }
    const now = Date.now();
    const elapsed = now - (current.last.get(id) ?? 0);
    const delay = (id === "global" ? mode.slowSeconds ?? 0 : configuredChannel(id)?.slowSeconds ?? 0) * 1_000;
    if (elapsed < delay) { tell(player, `Slow mode: try again in ${Math.ceil((delay - elapsed) / 1_000)}s.`, "yellow"); return true; }
    current.last.set(id, now);
  }
  if (id === "global") return false;
  const recipients = rune.players().filter((target) => canAccess(target, id) && (session(target).joined.has(id) || target.equals(player)));
  const line = `[${configuredChannel(id)?.name ?? id}] ${player.getName()}: ${text}`;
  for (const target of recipients) tell(target, line, id === "staff" ? "gold" : "aqua");
  return true;
}

export function channelId(input: string) {
  const id = input.toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,23}$/.test(id) || id === "global" || id === "staff") fail("Use a custom channel ID with 1–24 letters, numbers, or hyphens.");
  return id;
}

export function writeChannel(sender: CommandSender, input: string, value: Channel | undefined,
  done = feedback(sender).done, reject = feedback(sender).reject) {
  requirePermission(sender, "chat");
  const id = channelId(input);
  const name = value?.name.trim();
  if (value && (!name || name.length > 32 || /[\r\n]/.test(name))) fail("Use a channel name of 1–32 characters.");
  if (value) slowSeconds(value.slowSeconds);
  const staff = actor(sender);
  const at = Date.now();
  const operation = value ? `Saved channel ${id}.` : `Deleted channel ${id}.`;
  backend.edit((data) => {
    if (value) data.channels[id] = { ...value, name: name! };
    else {
      if (!Object.hasOwn(data.channels, id)) fail("Channel not found.");
      delete data.channels[id];
    }
    audit(data, staff, at, operation);
  }, () => done(operation), reject);
}

export function slowSeconds(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 600) fail("Use a slow-mode delay from 0 to 600 seconds.");
  return value;
}

function writePolicy(sender: CommandSender, permission: string, action: string, edit: (state: ChatPolicy) => void,
  done?: Done, reject?: Done) {
  requirePermission(sender, permission);
  const staff = actor(sender);
  const at = Date.now();
  backend.edit((data) => {
    if (!Object.hasOwn(data.policies, server)) data.policies[server] = {};
    edit(data.policies[server]);
    audit(data, staff, at, action);
  }, () => {
    informStaff(`[Moderation] ${staff.name}: ${action}`);
    (done ?? feedback(sender).done)(action);
  }, reject ?? feedback(sender).reject);
}

export function setSlow(sender: CommandSender, seconds: number, done?: Done, reject?: Done) {
  slowSeconds(seconds);
  writePolicy(sender, "chat", `Global slow mode: ${seconds}s.`, (state) => { state.slowSeconds = seconds; }, done, reject);
}

export function setLock(sender: CommandSender, key: "locked" | "lockdown", duration?: string, reason?: string, done?: Done, reject?: Done) {
  const label = key === "locked" ? "Public chat lock" : "Join lockdown";
  const value = duration === undefined ? undefined : { expiresAt: expiry(duration), reason: details(reason ?? "") };
  writePolicy(sender, key === "locked" ? "chat" : "lockdown", `${label} ${value ? "enabled" : "disabled"}.`, (state) => {
    if (value) state[key] = value;
    else delete state[key];
  }, done, reject);
}

export function clearChat(sender: CommandSender, reason: string, done = feedback(sender).done, reject = feedback(sender).reject) {
  requirePermission(sender, "chat");
  const staff = actor(sender);
  const text = details(reason);
  backend.edit((data) => audit(data, staff, Date.now(), "Cleared visible chat. " + text), () => {
    for (const player of rune.players()) {
      for (let line = 0; line < 22; line++) player.sendMessage(" ");
      tell(player, "Chat cleared by staff. " + text, "gold");
    }
    done("Cleared visible chat.");
  }, reject);
}

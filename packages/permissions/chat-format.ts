import { backend } from "./backend.ts";
import { globalChannel, normalizePlaceholders, playerValues, registerPlaceholders, resolveTemplate,
  type ChatChannel } from "./chat-placeholders.ts";

type ChannelDirectory = { list(): ChatChannel[] };
export const defaultFormats = {
  global: "<display_name><gray>: </gray><message>",
  channels: "<dark_gray>[</dark_gray><aqua><channel></aqua><dark_gray>] </dark_gray><display_name><gray>: </gray><message>",
};
export const chatPermissions = {
  view: "rune.permissions.chat.view",
  edit: "rune.permissions.chat.edit",
};

export const enabled = () => backend.value().chat?.enabled !== false;

function knownChannels(): ChatChannel[] {
  return rune.services.get<ChannelDirectory>("moderation-channels", 1)?.list() ?? [];
}

export function scopes() {
  const configured = Object.keys(backend.value().chat?.formats ?? {});
  const available = knownChannels().filter(({ id }) => id !== "global").map(({ id }) => "channel-" + id);
  return [...new Set(["global", "channels", ...available, ...configured])];
}

export function templateFor(scope: string) {
  const formats = backend.value().chat?.formats ?? {};
  if (Object.hasOwn(formats, scope)) return formats[scope];
  if (scope === "global") return defaultFormats.global;
  return Object.hasOwn(formats, "channels") ? formats.channels : defaultFormats.channels;
}

const example = {
  username: "Alex", display_name: "Alex", prefix: "[Guide] ", suffix: " ★", group: "guide",
  world: "world", channel: "Trade", channel_id: "trade",
};
const marker = "RuneChatMessagePlaceholder";

export function validateTemplate(template: string) {
  if (!template.trim() || template.length > 500 || /[\r\n]/.test(template)) {
    throw new Error("Enter a single line of 1–500 characters.");
  }
  const rendered = rune.adventure.miniMessage(normalizePlaceholders(template), { ...example, message: marker });
  if (!rune.adventure.serialize(rendered).includes(marker)) {
    throw new Error("Include <message> in the visible part of the format.");
  }
}

export function preview(scope: string, template: string, player?: Player) {
  validateTemplate(template);
  const id = scope.slice("channel-".length);
  const channel = scope === "global" ? globalChannel : knownChannels().find((value) => value.id === id);
  const selected = channel ?? { id: example.channel_id, name: example.channel };
  const { source, values } = resolveTemplate(template, player);
  const who = player ? { ...playerValues(player, selected), display_name: player.displayName() } : example;
  return rune.adventure.miniMessage(source, { ...values, ...who, channel: selected.name, channel_id: selected.id,
    message: "Hello, world!" });
}

export function saveFormat(sender: CommandSender, scope: string, template: string | undefined,
  done: () => void, reject: (error: string) => void) {
  if (!sender.hasPermission(chatPermissions.edit)) return reject("Requires " + chatPermissions.edit + ".");
  if (!scopes().includes(scope)) return reject("Choose global, channels, or one of the listed channel IDs.");
  try { if (template !== undefined) validateTemplate(template); }
  catch (error) { return reject(error instanceof Error ? error.message : "Invalid chat format."); }
  backend.edit((data) => {
    const chat = data.chat ??= {};
    const formats = chat.formats ??= {};
    if (template === undefined) delete formats[scope];
    else formats[scope] = template;
  }, done, reject);
}

export function setEnabled(sender: CommandSender, value: boolean, done: () => void, reject: (error: string) => void) {
  if (!sender.hasPermission(chatPermissions.edit)) return reject("Requires " + chatPermissions.edit + ".");
  backend.edit((data) => { (data.chat ??= {}).enabled = value; }, done, reject);
}

@Listener
export class FormatGlobalChat {
  @EventHandler(Events.AsyncChatEvent, { priority: "HIGHEST", ignoreCancelled: true })
  chat(event: AsyncChatEvent) {
    if (enabled() && typeof rune.adventure.formatChat === "function") {
      const player = event.getPlayer();
      const { source, values } = resolveTemplate(templateFor("global"), player);
      rune.adventure.formatChat(event, source, { ...values, ...playerValues(player, globalChannel) });
    }
  }
}

export function startChat() {
  rune.schedule.nextTick(registerPlaceholders);
  rune.services.provide("chat-format", 1, {
    channel(player: Player, channel: ChatChannel, message: string) {
      if (!enabled()) return undefined;
      const { source, values } = resolveTemplate(templateFor("channel-" + channel.id), player);
      return rune.adventure.miniMessage(source, {
        ...values, ...playerValues(player, channel), display_name: player.displayName(), message,
      });
    },
  });
}

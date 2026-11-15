const messages = rune.store("rune-announcements");
const config = rune.config("announcements", {
  enabled: { default: true, label: "Rotate messages" },
  "interval-seconds": { default: 300, min: 15, max: 3600, label: "Seconds between announcements" },
});
let previous: string | undefined;
let lastSent = Date.now();

function send(message: string) {
  const preferences = rune.services.get<{ get(id: string, key: "announcements"): boolean }>("preferences", 1);
  const text = rune.adventure.miniMessage(message);
  for (const player of rune.players()) {
    if (preferences?.get(String(player.getUniqueId()), "announcements") !== false) {
      rune.adventure.send(player, text);
    }
  }
}

rune.schedule.everyTicks(() => {
  const opts = config.read();
  const now = Date.now();
  if (!opts.enabled || now - lastSent < opts["interval-seconds"] * 1000 || !rune.players().length) return;
  const keys = messages.keys().sort();
  if (!keys.length) return;
  const next = keys[(keys.indexOf(previous ?? "") + 1) % keys.length];
  const message = messages.get<string>(next);
  if (message) send(message);
  previous = next;
  lastSent = now;
}, 20);

function id(ctx: CommandCtx, input: string) {
  const key = input.toLowerCase();
  if (/^[a-z0-9-]{1,32}$/.test(key)) return key;
  ctx.sender.sendMessage("Use 1–32 letters, numbers, or hyphens.");
  return null;
}

@Command("announcements", { description: "Manage rotating server messages", permission: "rune.admin" })
export class ListAnnouncements {
  @Run run({ sender }: CommandCtx) {
    sender.sendMessage("Announcements: " + (messages.keys().sort().join(", ") || "none"));
  }
}

@Command("announcements set", { permission: "rune.admin" })
export class SetAnnouncement {
  @Arg("id", { type: "word" }) id!: string;
  @Arg("message", { type: "greedy" }) message!: string;
  @Run run(ctx: CommandCtx) {
      const name = id(ctx, this.id);
      const message = this.message.trim();
      if (!name) return;
      if (!message || message.length > 400) { ctx.sender.sendMessage("Use a message of 1–400 characters."); return; }
      try { rune.adventure.miniMessage(message); }
      catch { ctx.sender.sendMessage("Invalid MiniMessage."); return; }
      messages.set(name, message);
      ctx.sender.sendMessage(`Saved announcement ${name}.`);
  }
}

@Command("announcements send", { permission: "rune.admin" })
export class SendAnnouncement {
  @Arg("id", { type: "word" }) id!: string;
  @Run run(ctx: CommandCtx) {
      const name = id(ctx, this.id);
      if (!name) return;
      const message = messages.get<string>(name);
      if (!message) { ctx.sender.sendMessage("Announcement not found."); return; }
      send(message);
      lastSent = Date.now();
  }
}

@Command("announcements delete", { permission: "rune.admin" })
export class DeleteAnnouncement {
  @Arg("id", { type: "word" }) id!: string;
  @Run run(ctx: CommandCtx) {
      const name = id(ctx, this.id);
      if (!name) return;
      if (!messages.has(name)) { ctx.sender.sendMessage("Announcement not found."); return; }
      messages.delete(name);
      ctx.sender.sendMessage(`Deleted announcement ${name}.`);
  }
}

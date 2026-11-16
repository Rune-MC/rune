import { paperRecords, StorageInputError } from "@rune/storage";

const messages = paperRecords<string>(rune, "announcements", "rune-announcements");
const announcementIds = () => Object.keys(messages.value()).sort();
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

rune.dashboard?.whenInstalled?.(async () => (await import("./dashboard.tsx")).registerDashboard(
  messages.value, config.read, (name) => {
    const data = messages.value();
    if (!Object.hasOwn(data, name)) throw new Error("Announcement not found.");
    send(data[name]);
    lastSent = Date.now();
  },
));

rune.schedule.everyTicks(() => {
  const opts = config.read();
  const now = Date.now();
  if (!opts.enabled || now - lastSent < opts["interval-seconds"] * 1000 || !rune.players().length) return;
  const data = messages.value();
  const keys = Object.keys(data).sort();
  if (!keys.length) return;
  const next = keys[(keys.indexOf(previous ?? "") + 1) % keys.length];
  const message = data[next];
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

@Command("announcements", { description: "Manage rotating server messages" })
export class ListAnnouncements {
  @Run run({ sender }: CommandCtx) {
    if (!sender.hasPermission("rune.announcements.list")) {
      sender.sendMessage("Requires rune.announcements.list.");
      return;
    }
    sender.sendMessage("Announcements: " + (announcementIds().join(", ") || "none"));
  }
}

@Command("announcements list", { permission: "rune.announcements.list" })
export class AnnouncementList {
  @Run run(ctx: CommandCtx) { new ListAnnouncements().run(ctx); }
}

@Command("announcements set", { permission: "rune.announcements.set" })
export class SetAnnouncement {
  @Arg("id", { type: "word", suggest: announcementIds }) id!: string;
  @Arg("message", { type: "greedy" }) message!: string;
  @Run run(ctx: CommandCtx) {
      const name = id(ctx, this.id);
      const message = this.message.trim();
      if (!name) return;
      if (!message || message.length > 400) { ctx.sender.sendMessage("Use a message of 1–400 characters."); return; }
      try { rune.adventure.miniMessage(message); }
      catch { ctx.sender.sendMessage("Invalid MiniMessage."); return; }
      messages.edit((data) => { data[name] = message; },
        () => ctx.sender.sendMessage(`Saved announcement ${name}.`), (error) => ctx.sender.sendMessage(error));
  }
}

@Command("announcements send", { permission: "rune.announcements.send" })
export class SendAnnouncement {
  @Arg("id", { type: "word", suggest: announcementIds }) id!: string;
  @Run run(ctx: CommandCtx) {
      const name = id(ctx, this.id);
      if (!name) return;
      const data = messages.value();
      const message = Object.hasOwn(data, name) ? data[name] : undefined;
      if (!message) { ctx.sender.sendMessage("Announcement not found."); return; }
      send(message);
      lastSent = Date.now();
  }
}

@Command("announcements delete", { permission: "rune.announcements.delete" })
export class DeleteAnnouncement {
  @Arg("id", { type: "word", suggest: announcementIds }) id!: string;
  @Run run(ctx: CommandCtx) {
      const name = id(ctx, this.id);
      if (!name) return;
      messages.edit((data) => {
        if (!Object.hasOwn(data, name)) throw new StorageInputError("Announcement not found.");
        delete data[name];
      }, () => ctx.sender.sendMessage(`Deleted announcement ${name}.`), (error) => ctx.sender.sendMessage(error));
  }
}

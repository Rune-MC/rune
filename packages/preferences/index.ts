import { paperRecords } from "@rune/storage";
const settings = ["announcements", "actionbars", "sounds"] as const;
type Setting = (typeof settings)[number];
const store = paperRecords<boolean>(rune, "preferences", "rune-player-preferences");

export function get(playerId: string, key: Setting): boolean {
  return store.value()[`${playerId}:${key}`] ?? true;
}

export function set(playerId: string, key: Setting, value: boolean): Promise<void> {
  if (!settings.includes(key)) throw new TypeError("Unknown preference");
  const slot = `${playerId}:${key}`;
  return new Promise((resolve, reject) => {
    store.edit((data) => {
      if (value) delete data[slot];
      else data[slot] = false;
    }, resolve, (message) => reject(new Error(message)));
  });
}

store.onChange((before, after) => {
  for (const slot of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const value = after[slot] ?? true;
    if ((before[slot] ?? true) === value) continue;
    const [playerId, key] = slot.split(":");
    void rune.events.emit("preferences.changed", { playerId, key, value });
  }
});

rune.services.provide("preferences", 1, { get, set });
@Command("preferences", { description: "View or toggle your personal settings" })
export class PreferencesCommand {
  @Arg("setting", { type: "word", optional: true, suggest: [...settings] }) setting?: string;
  @Run run({ sender }: CommandCtx) {
    if (!sender.isPlayer) { sender.sendMessage("Run this command in game."); return; }
    const playerId = String((sender as unknown as Player).getUniqueId());
    const key = settings.find((value) => value === this.setting);
    if (!key) {
      sender.sendMessage(settings.map((name) => `${name}: ${get(playerId, name) ? "on" : "off"}`).join(" | "));
      return;
    }
    const slot = `${playerId}:${key}`;
    store.edit((data) => {
      const value = data[slot] === false;
      if (value) delete data[slot];
      else data[slot] = false;
      return value;
    }, (value) => sender.sendMessage(`${key} is now ${value ? "on" : "off"}.`), (message) => sender.sendMessage(message));
  }
}

const settings = ["announcements", "actionbars", "sounds"] as const;
type Setting = (typeof settings)[number];
const store = rune.store("rune-player-preferences");

export function get(playerId: string, key: Setting): boolean {
  return store.get<boolean>(`${playerId}:${key}`) ?? true;
}

export function set(playerId: string, key: Setting, value: boolean) {
  if (!settings.includes(key)) throw new TypeError("Unknown preference");
  if (get(playerId, key) === value) return;
  const slot = `${playerId}:${key}`;
  if (value) store.delete(slot);
  else store.set(slot, false);
  void rune.events.emit("preferences.changed", { playerId, key, value });
}

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
    const value = !get(playerId, key);
    set(playerId, key, value);
    sender.sendMessage(`${key} is now ${value ? "on" : "off"}.`);
  }
}

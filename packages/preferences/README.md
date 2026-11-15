# Preferences

`rune add @rune/preferences`, then restart Paper.

`/preferences` shows your current values. Run `/preferences announcements`,
`/preferences actionbars`, or `/preferences sounds` to toggle a value.
Other Runes opt into honoring these preferences through the service.

```typescript
const prefs = rune.services.get<{
  get(id: string, setting: "announcements" | "actionbars" | "sounds"): boolean;
}>("preferences", 1);
if (prefs?.get(String(player.getUniqueId()), "sounds") !== false) {
  // Play your Rune's sound.
}
```

The `preferences.changed` event carries `{ playerId, key, value }`.
Defaults are enabled and changes persist by player UUID.

# @rune/preferences

Let players control announcements, action bars, and sounds from Runes
that read their preferences. Values default to on and persist by player UUID.

## Install and use

```sh
rune add @rune/preferences
```

Restart Paper. In game, `/preferences` lists your settings. Append
`announcements`, `actionbars`, or `sounds` to toggle a setting.
[@rune/announcements](https://runemc.dev/runebook/r/@rune%2Fannouncements)
honors the announcement setting for both manual and scheduled messages.

## Integrate another Rune

Read the version 1 `preferences` service. Check the preference before
sending messages, playing sounds, or updating the action bar.

```typescript
type Setting = "announcements" | "actionbars" | "sounds";
type Preferences = {
  get(playerId: string, key: Setting): boolean;
  set(playerId: string, key: Setting, value: boolean): Promise<void>;
};

function showNotice(player: Player, text: string) {
  const prefs = rune.services.get<Preferences>("preferences", 1);
  if (prefs?.get(String(player.getUniqueId()), "actionbars") !== false) {
    rune.adventure.actionBar(player, text);
  }
}
```

`set` waits for the storage write. The `preferences.changed` event carries
`{ playerId, key, value }`, including updates observed from shared storage.

## Storage

Use the server environment to set `RUNE_PREFERENCES_STORAGE` to `local`,
`reuse:shared`, or `connect`. For `connect`, install the database adapter and set
`RUNE_PREFERENCES_DB_URL`. The default keeps existing local data and otherwise prefers
an open connection when available. [Storage setup](https://github.com/Rune-MC/rune/tree/main/packages/storage#share-an-open-database-on-paper)

# @rune/announcements

Rotate formatted announcements on a Paper server and send important messages on demand.

## Install

```sh
rune add @rune/announcements
```

Restart Paper. Install [@rune/preferences](https://runemc.dev/runebook/r/@rune%2Fpreferences) if players should be able to opt out of announcements.

## Commands

Grant `rune.announcements.list`, `rune.announcements.set`,
`rune.announcements.send`, or `rune.announcements.delete` for the relevant
command. On Rune 0.5.2 or later, Tab completes saved announcement IDs.

| Command | Behavior |
| --- | --- |
| `/announcements` | List saved announcement IDs. |
| `/announcements set <id> <message>` | Save or replace a MiniMessage string. |
| `/announcements send <id>` | Send it immediately to eligible online players. |
| `/announcements delete <id>` | Remove it from the rotation. |

```text
/announcements set event <gold>Friday event at 7 PM</gold>
/announcements send event
/rune config announcements interval-seconds 120
```

IDs are case-insensitive and accept 1–32 letters, digits, or hyphens.
Messages can contain up to 400 characters. Automatic rotation follows ID
order and waits while the server is empty. Sending manually restarts the
interval without moving the rotation cursor.

## Settings and storage

`/rune config announcements` shows the current settings. `enabled` defaults
to `true` and controls automatic rotation. `interval-seconds` defaults to
`300` and accepts 15–3600 seconds.

Use the server environment to set `RUNE_ANNOUNCEMENTS_STORAGE` to `local`,
`reuse:shared`, or `connect`. For `connect`, install the database adapter and set
`RUNE_ANNOUNCEMENTS_DB_URL`. The default keeps existing local data and otherwise prefers
an open connection when available. [Storage setup](https://github.com/Rune-MC/rune/tree/main/packages/storage#share-an-open-database-on-paper)

## Web dashboard

With `@rune/dashboard` running on Rune 0.5.3 or newer, this Rune adds
its own navigation and pages. Browse saved announcements and send one immediately.

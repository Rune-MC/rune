# Announcements

Choose storage with `RUNE_ANNOUNCEMENTS_STORAGE`. Use `local`, `reuse:<name>`,
or `connect` with `RUNE_ANNOUNCEMENTS_DB_URL`. [Storage configuration](https://github.com/Rune-MC/rune/tree/main/packages/storage#share-an-open-database-on-paper)

`rune add @rune/announcements`, then restart Paper.

- `/announcements set event <gold>Friday event at 7 PM</gold>` saves a message.
- `/announcements send event` sends it now.
- `/announcements` lists message IDs.
- `/announcements delete event` removes it.

The rotation skips empty servers and runs in ID order. Use
`/rune config announcements` to set the interval or pause it. Install
`@rune/preferences` to let players opt out. Management requires `rune.admin`.

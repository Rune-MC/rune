# NPCs

Choose storage with `RUNE_NPCS_STORAGE`. Use `local`, `reuse:<name>`,
or `connect` with `RUNE_NPCS_DB_URL`. [Storage configuration](https://github.com/Rune-MC/rune/tree/main/packages/storage#share-an-open-database-on-paper)

`rune add @rune/npcs`, then restart Paper.

- `/npc create guide Town Guide` places a named villager where you stand.
- `/npc say guide Welcome to town!` sets its right-click dialogue.
- `/npc` lists IDs and `/npc remove guide` removes one.

Definitions persist by world and position. Entities are recreated when
their chunk loads. Right-clicks emit `npcs.interact` with
`{ npcId, playerId, playerName }` for quests and menus to consume. Remove
loaded NPCs before uninstalling or restart Paper to discard their entities.
Management requires `rune.admin`.

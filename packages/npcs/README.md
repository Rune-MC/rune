# @rune/npcs

Place persistent named villagers with click dialogue and an interaction
event for quests, menus, and other Runes.

## Install and place an NPC

```sh
rune add @rune/npcs
```

Restart Paper. Stand where the villager should appear and run these
commands with `rune.npcs.list`, `rune.npcs.create`, `rune.npcs.say`, or
`rune.npcs.remove`. On Rune 0.5.2 or later, Tab completes saved NPC IDs.

```text
/npc create guide Town Guide
/npc say guide Welcome to town!
```

| Command | Behavior |
| --- | --- |
| `/npc` | List NPC IDs. |
| `/npc create <id> [title]` | Create an NPC with a new ID at your location. |
| `/npc say <id> [line]` | Set the dialogue or clear it by omitting the line. |
| `/npc remove <id>` | Delete the definition and remove a loaded villager. |

IDs accept 1–24 letters, digits, underscores, or hyphens. Titles can be
up to 64 characters and dialogue can be up to 300 characters.

Definitions store the world and position. Loaded NPCs are restored after
restart and later chunks restore their NPCs on load. Remove loaded NPCs
before uninstalling or restart Paper to discard their nonpersistent entities.

## Handle a right-click

```typescript
rune.events.on<{ npcId: string; playerId: string; playerName: string }>(
  "npcs.interact",
  ({ npcId, playerId }) => {
    const player = rune.player(playerId);
    if (npcId === "guide") player?.sendMessage("Visit the market to begin.");
  },
);
```

## Storage

Use the server environment to set `RUNE_NPCS_STORAGE` to `local`,
`reuse:shared`, or `connect`. For `connect`, install the database adapter and set
`RUNE_NPCS_DB_URL`. The default keeps existing local data and otherwise prefers
an open connection when available. [Storage setup](https://github.com/Rune-MC/rune/tree/main/packages/storage#share-an-open-database-on-paper)

## Web dashboard

With `@rune/dashboard` running on Rune 0.5.3 or newer, this Rune adds
its own navigation and pages. Browse NPCs and edit their dialogue.

## Dashboard

Open **NPCs** in Rune Dashboard to create, move, remove, rename, or edit the dialogue of an NPC. Placement uses the position of an online player. This page requires Rune 0.5.4 or newer and @rune/dashboard 0.1.2 or newer.

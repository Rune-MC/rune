# Rune examples

Each directory is a Rune package. Copy the directories you want into
`plugins/Rune/scripts/` once Rune has created it. Restart Paper to register
commands and link library Runes. Use the updated Rune CLI to run
`rune pack --dir examples/sprint-arena` from this repository, or change the
directory to package any of the other examples.

| Package | Use |
| --- | --- |
| `game-kit` | Reusable party matchmaking and action-bar display. |
| `sprint-arena` | Timed parkour race with party matchmaking, a running timer, win counts, and automatic return to the player's original location. Copy `game-kit` with it. |
| `sprint-rewards` | Listens for race results, awards Vault currency, and announces quest completion after the configured number of wins. Copy `sprint-arena` and `vault` with it. |
| `vault` | Import `deposit` or `vaultEconomy` from `@rune/vault`. Payouts require Vault and an economy provider. |
| `placeholderapi` | Import `placeholders(player, text)` from `@rune/placeholderapi`. |
| `worldguard` | Import `regionsAt(location)` from `@rune/worldguard`. Install WorldGuard and WorldEdit for region lookups. |
| `dashboard` | Local browser console with TypeScript and JavaScript load status, recent script logs, settings, reload, and panels. |

## Run Sprint Arena

1. Stand at the starting point and run `/arena set-start` as an operator. Set the
   finish the same way with `/arena set-finish`. Use a course in a protected
   world or region.
2. Run `/arena join` from two player accounts. Players can use
   `/arena join <party-name>` to queue together in the same match.
3. Reach the finish first. The arena restores player positions at the end
   of each round and records the winner. With Sprint Rewards installed,
   the win can also pay out currency and count toward a quest.

View settings with `/rune config sprint-arena`. For example,
`/rune config sprint-arena round-seconds 60` adjusts future rounds.
Install `@rune/storage` for the arena's persistent settings and scores.
Use `RUNE_SPRINT_ARENA_STORAGE` to choose its storage.
[Storage settings](../packages/storage/README.md#share-an-open-database-on-paper)

## Use the dashboard

Install [@rune/dashboard](../packages/dashboard/README.md) and restart Paper.
Visit `http://127.0.0.1:8777` from the server or through an SSH tunnel and
create the owner account. Installed Runes can add tools, pages, and actions.

## Extend the examples

Sprint Arena publishes the `sprint-arena` service (major version 1) and emits
`sprint-arena.finished`. Sprint Rewards is one example of a consumer. Add
your own handler for announcements or stats. Use `rune.services`,
`rune.events`, `rune.config`, and `rune.dashboard.panel` from TypeScript.
Your registries rebuild on a server-wide Rune reload.

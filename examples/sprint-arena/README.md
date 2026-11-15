# @rune/sprint-arena

Run timed parkour races with party matchmaking, persistent win totals, and
automatic return to the player's original position.

## Install and run a race

1. Install `@rune/storage`. Copy this directory and `examples/game-kit` into
   `plugins/Rune/scripts/` and restart Paper.
2. Stand at the start and run `/arena set-start`. Set the finish with
   `/arena set-finish`. These commands require `rune.admin`.
3. Players use `/arena join [party]` to queue and `/arena leave` to leave.
   Matching party names keep players together. The default queue starts
   with at least two players.

Use `/rune config sprint-arena` to see the settings. `minimum-players`
defaults to 2, `maximum-players` to 12, and `round-seconds` to 45.
Run the course in a world or region managed as an arena.

## Storage and events

`RUNE_SPRINT_ARENA_STORAGE` selects local storage, a shared connection,
or a new connection. For a new connection, install the relevant adapter
and set `RUNE_SPRINT_ARENA_DB_URL`. [Storage setup](https://github.com/Rune-MC/rune/tree/main/packages/storage#share-an-open-database-on-paper)

Consume the custom event `sprint-arena.finished` with
`{ playerId, name, elapsedSeconds }`. The version 1 `sprint-arena` service
provides `wins(playerId)` for scores and `status()` for queued and racing
player counts. Sprint Rewards consumes the finish event and win count.

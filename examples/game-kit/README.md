# @rune/game-kit

Reusable party batching and action-bar messages for Paper mini-games.

## Install

Copy this directory into `plugins/Rune/scripts/` and restart Paper. Import it from your TypeScript Rune.

```typescript
import { MatchQueue } from "@rune/game-kit";

const queue = new MatchQueue();
queue.join("player-one", "blue");
queue.join("player-two", "blue");
queue.join("player-three");

const teams = queue.groups(2);
// [["player-one", "player-two"]]
```

## API

- `join(playerId, party?)` queues a player or changes their party.
- `leave(playerId)` removes them from the queue.
- `size` counts players. `partyCount` counts distinct named parties.
- `groups(capacity)` returns parties and solo groups that fit, in queue
  order. Oversized groups are skipped and the queue remains available
  for a later match. Remove selected players explicitly once a match starts.
- `actionBar(players, message)` sends plain text to an iterable of Paper players.

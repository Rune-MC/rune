# Pagination

`rune add @rune/pagination`

```typescript
import { paginate, numberedLines } from "@rune/pagination";

const page = paginate(players, { page: requestedPage, pageSize: 8 });
sender.sendMessage(`Players (${page.page}/${page.pages})`);
for (const line of numberedLines(page, (player) => player.getName())) {
  sender.sendMessage(line);
}
```

Pages start at one and clamp to the available range. `next` and `previous`
are null at the edges. Empty lists have one empty page. Sort a copy of the
source list first if you want a stable ordering across separate requests.

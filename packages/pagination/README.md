# @rune/pagination

Paginate an in-memory array for chat output, menus, or an API response.

## Install and use

```sh
rune add @rune/pagination
```

```typescript
import { paginate, numberedLines } from "@rune/pagination";

const players = ["Alex", "Blake", "Casey", "Drew"];
const page = paginate(players, { page: 2, pageSize: 2 });
const lines = numberedLines(page);
// ["3. Casey", "4. Drew"]
```

## API

`paginate(items, { page, pageSize })` returns the selected `items`,
`page`, `pageSize`, `total`, `pages`, `offset`, `previous`, and `next`.
Defaults are page 1 and ten items per page. Integer pages clamp to the
available range. Empty arrays have one empty page. `previous` and `next`
are `null` at the edges.

`numberedLines(page, render?)` formats rows with their one-based position
in the full array. The optional renderer receives the item and its number.
Sort a copy of the input first if you need stable ordering between requests.

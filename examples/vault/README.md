# @rune/vault

Call a Vault economy provider from a Paper Rune.

## Install

Install the Vault plugin and an economy provider, then restart Paper with
this directory in `plugins/Rune/scripts/`.

```typescript
import { deposit, vaultEconomy } from "@rune/vault";

function reward(player: Player) {
  const deposited = deposit(player, 25);
  const balance = vaultEconomy()?.getBalance(player);
  return { deposited, balance };
}
```

## API

`vaultEconomy()` returns the registered economy provider or `undefined`.
`deposit(player, amount)` accepts a `Player` or `OfflinePlayer` and a finite
positive amount. It returns `false` when no provider is available or the
transaction fails. The provider controls currency units and formatting.

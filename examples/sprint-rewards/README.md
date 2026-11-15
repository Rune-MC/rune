# @rune/sprint-rewards

Award Vault currency to Sprint Arena winners and announce a quest
milestone at a configured number of wins.

## Install

Set up Sprint Arena and copy this directory and `examples/vault` into
`plugins/Rune/scripts/`. Enable Vault and its economy provider on Paper
and restart the server.

Sprint Arena provides the result event and stored win count. This Rune
listens for `sprint-arena.finished` and rewards the winner when they are
online. It logs a warning if the economy provider declines a payout.

## Configure rewards

| Setting | Default | Behavior |
| --- | --- | --- |
| `payout` | `25` | Amount deposited for a win. Set it to 0 to turn payouts off. |
| `quest-wins` | `3` | Win count at which the quest completion message is sent. |

Use `/rune config sprint-rewards` to view settings. For example,
`/rune config sprint-rewards payout 50` changes the payout to 50.

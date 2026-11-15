# @rune/anticheat

Monitor sustained horizontal speed and direct melee hit rate on Paper.
Alerts go to the console and staff with `rune.anticheat.alerts`. This Rune
is alert-only. Staff decide what action to take after reviewing the alert.

## Install and inspect alerts

```sh
rune add @rune/anticheat
```

Restart Paper. Use `/anticheat` for monitoring status and estimated TPS or
`/anticheat <online-player>` to inspect that player. The command requires
`rune.anticheat.alerts`. Use `rune.anticheat.bypass` for users with known
custom movement. Alert counters live in memory and reset when a player
disconnects or the Rune reloads.

## Tune the checks

| Setting | Default | Unit |
| --- | --- | --- |
| `enabled` | `true` | Enable monitoring |
| `speed-limit` | `13` | Horizontal blocks per second |
| `hit-limit` | `12` | Direct melee hits per second |
| `max-ping` | `200` | Milliseconds |
| `min-tps` | `17` | Server ticks per second |

Use `/rune config anticheat` to inspect or edit values. For example, use
`/rune config anticheat speed-limit 16`. Flight, vehicles, swimming,
movement effects, recent teleports or velocity, high latency, and low TPS
affect eligibility or thresholds.

## Consume alerts

Subscribe to the custom Rune event `anticheat.alert` for moderation logs or staff notifications.

```typescript
type Alert = {
  playerId: string;
  name: string;
  check: string;
  rate: number;
  limit: number;
  timestamp: number;
};

rune.events.on<Alert>("anticheat.alert", (alert) => {
  console.info(alert.name, alert.check, alert.rate, alert.limit);
});
```

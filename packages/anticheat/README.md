# Anticheat

`rune add @rune/anticheat`, then restart Paper.

Configurable monitoring for sustained horizontal speed and direct melee
hit rate. Alerts go to the console and players with
`rune.anticheat.alerts`. `/anticheat [player]` reports session alerts.
The `anticheat.alert` event includes the check, player UUID, measured
rate, threshold, and timestamp.

Use `/rune config anticheat` to tune limits for your server. Flight,
vehicles, swimming, speed effects, teleport grace, low TPS, and high ping
are considered. Grant `rune.anticheat.bypass` for known custom movement.
Treat every alert as a signal to investigate. This Rune applies no kicks,
bans, damage changes, or movement corrections.

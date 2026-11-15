# @rune/moderation

Paper moderation with an in-game staff GUI and a console-friendly command tree.
Punishments, reports, staff notes, channel definitions, and audit history persist
across restarts.

## Install

```sh
rune add @rune/moderation
```

Restart Paper to register the commands. Operators can run `/mod gui` in-game or
`mod help` from the server console. `/mod help 2` shows the remaining commands.

## Punishments and durations

```text
/mod warn Alex Spamming trade chat
/mod mute Alex 15m Repeated spam after warning
/mod freeze Alex 2m Hold for a staff review
/mod ban Alex 1mo2d Repeated griefing
/mod ipban 192.0.2.14 1y Network ban
/mod kick Alex Rejoin with the correct client
/mod note Alex Reviewed the report with staff
/mod unmute Alex Appeal accepted
```

| Unit | Meaning | Example |
| --- | --- | --- |
| `s` | Seconds | `30s` |
| `m` | Minutes | `15m` |
| `h` | Hours | `2h` |
| `d` | Days | `3d` |
| `w` | Weeks | `1w` |
| `mo` | UTC calendar months | `1mo` |
| `y` | UTC calendar years | `1y` |

Combine units with `1h30m` or `1y2mo3d`. Quote a duration in commands to
include spaces, such as `"1h 30m"`. Months and years clamp at the end of the
target month. Use `permanent` or `perm` for an indefinite punishment.

Use an exact online or known offline name, or a UUID. Kicks require an
online player. IP bans use a literal IPv4 or IPv6 address. Staff actions
protect operators and players with `rune.moderation.immune`. The server
console can override this protection. Only staff with IP-ban access see
the address in case views.

## Staff command reference

| Command | Use |
| --- | --- |
| `/mod gui` | Search players, issue or revoke cases, review reports, and manage chat. |
| `/mod ban <player> <duration> <reason>` | Block account login. |
| `/mod ipban <address> <duration> <reason>` | Block an exact address. |
| `/mod mute <player> <duration> <reason>` | Block chat and configured messaging commands. |
| `/mod freeze <player> <duration> <reason>` | Block movement, basic interactions, breaking/placing blocks, and direct attacks. |
| `/mod kick <player> <reason>` | Disconnect an online player and record the case. |
| `/mod warn <player> <reason>` | Record a warning and notify the player when online. |
| `/mod note <player> <reason>` | Record a staff-only note. |
| `/mod unban\|unmute\|unfreeze <player> <reason>` | Revoke the corresponding active punishment. |
| `/mod unipban <address> <reason>` | Revoke the active IP ban. |
| `/mod revoke <case> <reason>` | Revoke a specific case and preserve its history. |
| `/mod cases [page]`, `/mod active [page]` | Browse all recorded cases or active punishments. |
| `/mod case <id>`, `/mod history <player> [page]` | Inspect a case or one player's history. |
| `/mod inspect <player>`, `/mod tp <player>` | View a profile or teleport to an online player. |
| `/mod audit [page]` | Review up to 500 recent settings changes and clear-chat actions. |

GUI forms accept private replies directly in chat. Type `!cancel` to go back.
The prompt expires after 60 seconds. Right-click duration fields for presets.
Punishments and revocations show a confirmation before they are saved.

## Reports

Players can run `/report <player> <reason>` or `/report gui`.
Staff can claim, resolve, or reopen reports in the dashboard.

```text
/mod reports
/mod report 12
/mod report claim 12
/mod report resolve 12 Reviewed chat and warned the player
/mod reports closed
/mod report reopen 12
```

The default report cooldown is 60 seconds. An open report for the same
reporter and target must be resolved before the reporter can file another.

## Chat channels and server controls

Players can browse with `/channel` or `/channel gui`.
`/channel join help` listens to Help, `/channel focus help` sends normal
chat to Help, and `/channel leave help` stops listening. `/channel focus global`
returns outgoing messages to standard Paper chat. `/channel send trade Selling
iron` sends one message without changing focus. `/staffchat <message>` sends
to staff listening on this server. Help and Trade are included. Channel membership
and focus reset on disconnect or reload.

```text
/mod chat channel set builders true 3 Build Team
/mod chat channel delete builders
/mod chat slow 5
/mod chat lock 10m Under review
/mod chat unlock
/mod chat clear Removed spam
/mod lockdown 15m Investigating an incident
/mod unlock
```

A restricted channel requires `rune.moderation.channel.<id>`. The slow-mode
delay is measured in seconds. Use zero to turn it off. Public chat locks
leave staff chat available. Join lockdown lets staff and players with
`rune.moderation.join-bypass` stay on join. Clear-chat pushes the visible
feed back by sending blank lines and a staff notice.

## Staff permissions

Paper operators have full staff access. For delegated staff, grant
`rune.moderation.use` to open the dashboard and see case history. Grant
`rune.moderation.admin` alongside it for all staff capabilities, or
assign only what the role needs.

| Suffix under `rune.moderation.` | Capability |
| --- | --- |
| `ban`, `ipban`, `mute`, `freeze`, `kick`, `warn`, `note` | Issue that type of case. |
| `revoke` | Revoke cases for action types the staff member can issue. |
| `reports`, `audit`, `teleport` | Review reports, read settings audits, or teleport to players. |
| `chat`, `lockdown` | Manage chat or restrict joins. |
| `notify`, `staffchat` | Receive moderation alerts or use staff chat. |
| `chat-bypass`, `join-bypass`, `immune` | Bypass chat limits or join lockdown, or protect the player from staff actions. |

Use `/rune config moderation` to configure report cooldown and the
comma-separated `mute-commands` list. Add aliases from third-party messaging
plugins when you use them.

## Storage and integrations

Choose `RUNE_MODERATION_STORAGE=local`, `reuse:shared`, or `connect`.
Set `RUNE_MODERATION_DB_URL` for a new connection, and install its adapter.
Automatic selection keeps existing local data and otherwise prefers an open
connection. [Storage setup](https://github.com/Rune-MC/rune/tree/main/packages/storage#share-an-open-database-on-paper)

With shared storage, cases and reports are shared and reach other servers
on their next poll. Set a different `RUNE_MODERATION_SERVER` on each server
so chat locks, global slow mode, and join lockdown apply to the intended server.
Chat messages stay on the sending server. Login waits for the first storage
snapshot and enforcement uses the last fetched data during a database outage.

The version 1 `moderation` service exposes `active(kind, target)` and
`ban(uuid, ip?)`. The custom events `moderation.case.created`,
`moderation.case.revoked`, and `moderation.report.updated` expose locally
committed updates for integrations.

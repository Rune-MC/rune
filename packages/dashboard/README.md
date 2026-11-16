# @rune/dashboard

The official React operator console for Rune. Monitor the Paper process,
inspect Rune and Bukkit plugin statistics, and manage installed Runes from
pages they contribute to the console.

## Install

Install Rune 0.5.4 or newer. Run `rune add @rune/dashboard` from the Paper
server folder and restart Paper. Open `http://127.0.0.1:8777` on the
server. For a remote Minecraft server, forward the port over SSH.

```sh
ssh -L 8777:127.0.0.1:8777 user@minecraft-host
```

Create an account on first launch. The account becomes the owner and gets
full dashboard access. Signup closes as soon as an owner exists. Sign-in,
session revocation, and password changes use `@rune/web-auth`.

- `RUNE_DASHBOARD_SETUP_TOKEN` adds a server-side token to first-time setup.
  The older `RUNE_DASHBOARD_TOKEN` also works as a setup token.
- `RUNE_DASHBOARD_PORT` changes the loopback port.
- `RUNE_DASHBOARD_STORAGE=local` keeps credentials and sessions in Rune’s
  persistent local store. `reuse:<name>` selects an existing
  `@rune/storage` connection. `connect` uses `RUNE_DASHBOARD_DB_URL`
  and an installed database adapter. The owner is scoped to the selected
  storage. Keep that storage backed up.

Stop any previous dashboard launcher before starting this module.

## Monitor the server

- **Overview** tracks TPS, tick time, players, process CPU and resident
  memory, JVM heap and GC, and the Node runtime. Charts show up to fifteen
  minutes of history.
- **Runes** shows versions, startup status and time, logs, and counts and
  synchronous timing for Node callbacks. Libraries have no standalone
  startup or callback totals.
- **Server** lists Bukkit plugins with listener counts and pending Bukkit
  tasks where available, plus worlds and loaded chunks. It also supports a
  confirmed Rune reload.
- **Players**, **Logs**, **Settings**, **Activity**, and **Account** expose
  live presence, recent Rune output, registered config, web changes, and
  authentication controls.

Player lists show Minecraft heads fetched by the dashboard from Minotar.
The request contains the player's UUID or Minecraft username. The
dashboard caches the image and shows a generic icon when it can't load.

## Manage official Runes

- **Permissions** edits groups, inheritance, scoped grants and rules,
  prefixes, suffixes, primary groups, promotion tracks, and per-channel
  chat formats. It can explain effective permissions for a player.
- **Moderation** issues and revokes punishments, reviews reports, manages
  channels, and controls slow mode, chat locks, and join lockdown.
- **Announcements** creates, edits, deletes, sends, and rotates messages.
- **Homes**, **Warps**, and **NPCs** manage saved destinations, entities,
  and NPC dialogue. Position-based actions use a selected online player.
- **Preferences** manages individual player settings. **Anticheat** shows
  detection alerts and edits monitoring thresholds.

CPU and memory are measured for the shared server process. Rune callback
timing measures synchronous execution in the Node runtime. Samples and
callback counts restart with the runtime. Management activity and accounts
persist.

## Extend the console

`rune.dashboard.isInstalled()` reports whether the official console is
running. `rune.dashboard.whenInstalled(callback)` runs your integration
when the console starts, even if your Rune loads first. Put your dashboard
imports inside that callback so pages are loaded only when needed. Return
the disposer from `rune.dashboard.register()` to unregister the tool if
you dispose of the callback.

`rune.dashboard.register()` accepts an ID, display title, and optional
`metrics`, `navigation`, `overview`, `pages`, and `actions`. Use
lowercase kebab-case IDs. Each `navigation` entry can link to a registered
page and override its label. Omit `navigation` for one link to the tool's
landing page. Set `overview` to add a React widget to the overview.

Write contributed pages as `.tsx` with `/** @jsxImportSource rune:dashboard */`.
The console supplies its React runtime and exports `Table`, `Details`,
`Card`, `Operations`, and `PlayerIdentity` from `rune:dashboard`. Pages render on
the server. Use `context.href(page)` for links and
`context.action(id, defaults)` for authenticated forms.
Actions declare typed fields and can require confirmation. The console
validates submitted values and records the outcome in Activity. Use
`context.onMain()` for Paper API calls after awaiting I/O.

Set `player: "known"` on a string action field to show a searchable
player picker. Set `player: "online"` when the action requires a live
player. The picker submits the UUID and shows the player's head, name,
and UUID. Validate that the player is still online when your action runs.

Moderation, Permissions, Anticheat, Announcements, Homes, Warps, NPCs, and
Preferences all contribute pages when installed. Their source also shows
how to register pages and wire actions to existing Rune logic.

## Build from source

Run `npm install` and `npm run build` in this directory before copying
it into the Paper scripts folder. The build bundles the React client for
live statistics. Rune loads server TypeScript and TSX directly. Runebook
archives include the browser bundle.

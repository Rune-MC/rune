# @rune/permissions

Manage Paper permissions, ranks, player labels, and chat formats from an
in-game GUI or commands.

## Install and upgrade

```sh
rune add @rune/permissions
```

Restart Paper, then use `/permissions gui` in game. For an existing installation,
run `rune add @rune/paper-ui` and `rune update @rune/storage` before
`rune update @rune/permissions`.
Upgrade any installed database adapter as well. Existing groups, direct
memberships, and storage settings still work.
Use Rune 0.5.2 or later for live Tab completion and Global chat formatting.
Update `@rune/moderation` to 0.1.3 or later for per-channel formatting.

## In-game Permissions Manager

Run `/permissions gui` in game. Grant `rune.permissions.gui` to open the
manager. Editing ranks and permission rules also requires operator status.

- **Groups** — create and delete groups, set weights, edit direct parents,
  view inherited parents and members, assign ranks, and manage rules and labels.
- **Players** — open online or known offline players by name, or enter a
  UUID. Manage primary groups, permanent and temporary grants, direct rules,
  and player-specific labels. Preview resolved prefixes and suffixes.
- **Effective access** — browse the resolved permissions and their sources,
  or test a concrete node in a chosen server or world. For an online player
  in their current context, the result also shows Bukkit's actual decision.
- **Promotion tracks** — create, reorder, and delete tracks, then preview and
  confirm the next rank when promoting or demoting a player.
- **Chat formats** — preview, edit, reset, and toggle Global and per-channel
  layouts. The editor accepts private chat replies. Staff with channel-management
  access can open Moderation's channel settings from the same screen.
- **Audit and settings** — search the latest 200 data edits and manage the
  local display-name, tab-list, and stacking options. Storage status is visible
  here. To select a backend, set the environment before restarting.

Lists support search and pagination. For rules, right-click the node field
to browse registered permissions. Right-click context and duration fields
for presets. When a text field opens a prompt, type your reply directly
in chat within 60 seconds. Your reply goes to the form privately.
Type `!cancel` to return to the editor. Chat resumes after you reply,
cancel, or the prompt expires.

## Chat formatting

Global is the default chat channel and uses the `global` format. Set
`channels` as a shared format for other channels, and override it for
specific IDs such as `channel-staff` or `channel-trade`. Channels created
in Moderation appear in Tab completion and in the GUI as soon as they are saved.
Resetting a channel restores the shared channel format. Formatting starts enabled.

```text
/permissions chat
/permissions chat show
/permissions chat set global <prefix><username><suffix> <gray>»</gray> <message>
/permissions chat set channel-trade <gold>[<channel>]</gold> <display_name>: <message>
/permissions chat preview channel-trade
/permissions chat reset channel-trade
/permissions chat toggle false
```

Templates accept MiniMessage. Use `<username>`, `<display_name>`,
`<prefix>`, `<suffix>`, `<group>`, `<world>`, `<channel>`,
`<channel_id>`, and `<message>`. Include `<message>` in the visible
format. The display name can already include a rank prefix or suffix.
Use the username placeholder when placing labels individually.

Each built-in placeholder also has a percent form such as `%rune_prefix%`
or `%rune_message%`. With PlaceholderAPI installed, Rune registers these
for other plugins and resolves third-party placeholders such as
`%player_name%` from installed expansions. External uses of
`%rune_channel%` and `%rune_channel_id%` default to Global.
`%rune_message%` is empty outside the chat formatter.

## Groups and player labels

```text
/permissions create builder
/permissions weight builder 20
/permissions prefix builder 100 <green>[Builder]</green>
/permissions suffix builder 20 <gray>Architect</gray>
/permissions member Alice builder true
/permissions inspect Alice
```

Higher label priorities win. By default, Permissions decorates both the
Paper display name and tab list. Team colors and custom chat renderers can
set their own presentation. Use `/rune config permissions` to turn either
output off. Turn on `stack-prefixes` or `stack-suffixes` to display ranked
labels from multiple groups with duplicate text removed.

Use `-` as the label text to remove the priority slot.
`/permissions label "user:Alice" prefix 150 global <gold>[Founder]</gold>`
sets a user label. Use `"world=hub"` to scope a label.
Use `group:<group>` as the subject for a scoped group label.

## Scoped access

```text
/permissions rule builder "example.build.*" allow
/permissions user-rule Alice example.build.delete deny "world=spawn" 2h
/permissions grant Alice builder "server=survival,world=world" 7d
/permissions revoke Alice builder "server=survival,world=world"
/permissions inherit architect builder true
/permissions explain Alice example.build.delete "world=spawn"
```

Rules and grants accept `global`, `"world=name"`, `"server=name"`, or a
combined context. Set `RUNE_PERMISSIONS_SERVER` to a different name for
each Paper process sharing the same database. Accepted durations include
`30m`, `2h`, `7d`, and `permanent`. Commands taking the `player`
argument accept online names or offline UUIDs. Use `unset` to remove a
rule in the specified context.

Permission decisions favor direct user rules, then more specific
contexts, more specific nodes, and higher group weight. Denies win equal
matches. Wildcards apply to registered Bukkit permission nodes and
explicit nodes in the same profile. Other Runes can check additional nodes
through the service. Everyone inherits the `default` group.

## Promotions, audit, and integrations

```text
/permissions track-set builders builder architect
/permissions promote Alice builders
/permissions demote Alice builders
/permissions primary Alice architect
/permissions audit 10
```

Tracks update permanent, global membership. They leave scoped and
temporary grants in place. The audit log keeps the latest 200 successful
edits. Only server operators can modify permissions.

The `permissions` service (major version 1) exposes `groups(uuid, context)`,
`rules(uuid, context)`, `check(uuid, node, context)`,
`explain(uuid, node, context)`, and `meta(uuid, context)`. The last method
returns the primary group and ordered MiniMessage prefix and suffix arrays.

## Command reference

The base command is `/permissions`. Tab completes groups, known players,
permission nodes, contexts, duration presets, tracks, and track members.

| Subcommands | Permission suffix under `rune.permissions.` |
| --- | --- |
| `gui` | `gui` |
| `groups`, `create`, `delete`, `weight`, `inherit` | `group.list`, `group.create`, `group.delete`, `group.weight`, `group.inherit` |
| `rule`, `user-rule` | `rule.group`, `rule.user` |
| `member`, `grant`, `revoke`, `primary` | `member.set`, `member.grant`, `member.revoke`, `member.primary` |
| `prefix`, `suffix`, `label` | `label.prefix`, `label.suffix`, `label.set` |
| `tracks`, `track-set`, `track-delete`, `promote`, `demote` | `track.list`, `track.set`, `track.delete`, `track.promote`, `track.demote` |
| `inspect`, `explain`, `audit` | `inspect`, `explain`, `audit` |
| `chat show`, `chat preview` | `chat.view` |
| `chat set`, `chat reset`, `chat toggle` | `chat.edit` |

An exact node such as `rune.admin` grants that node alone, apart from any
children explicitly declared by a Bukkit plugin. A Rune Permissions rule
such as `rune.permissions.chat.*` matches registered child nodes including
`chat.view` and `chat.edit`. Use specific namespaces when moving roles
that previously relied on `rune.admin`. Rune core commands use
`rune.core.status`, `rune.core.config`, `rune.core.new`, and `rune.core.reload`.

| Subcommand | Arguments and behavior |
| --- | --- |
| `gui` | Open the in-game manager. |
| `create`, `delete` | Pass a group name. Deleting a group cleans up its links, grants, and track entries. The `default` group is required. |
| `weight` | Pass a group and an integer from -100000 to 100000. |
| `inherit` | Pass a child group, parent group, and optional `true` or `false`. |
| `rule` | Pass a group, node, `allow\|deny\|unset`, optional context, and optional duration. |
| `user-rule` | Pass a player, node, decision, optional context, and optional duration. |
| `member` | Pass an online player, group, and optional `true` or `false` for permanent global membership. |
| `grant`, `revoke` | Pass a player, group, and optional context. `grant` also accepts a duration. |
| `primary` | Pass a player and optional group. Omit the group for automatic selection. |
| `prefix`, `suffix` | Pass a group, priority, and MiniMessage text to set a global label. |
| `label` | Pass a subject, `prefix` or `suffix`, priority, context, and text. |
| `tracks`, `track-set`, `track-delete` | List tracks, save a named track with its groups in order, or remove a track by name. |
| `promote`, `demote` | Pass a player and track. |
| `inspect`, `explain` | Inspect an online player's profile, or pass a player, concrete permission node, and optional context to explain a decision. |
| `audit` | Show recent edits. Pass an optional limit from 1 to 50. |

## Storage

Set `RUNE_PERMISSIONS_STORAGE` to `local`, `reuse:<name>`, or
`connect`. For a new connection, install the relevant database adapter
and set `RUNE_PERMISSIONS_DB_URL`. These options use the shared connection
registry and retain options from previous versions, including a DB URL on
its own. [Storage configuration](https://github.com/Rune-MC/rune/tree/main/packages/storage#share-an-open-database-on-paper)

Changes reach other servers on their next poll, usually within five
seconds. After a sustained database outage, Permissions clears the
permissions and labels it applied until the database becomes available.
Back up your database and restart all servers using it when upgrading the
Permissions Rune.

## Web dashboard

With `@rune/dashboard` running on Rune 0.5.3 or newer, this Rune adds
its own navigation and pages. View groups and chat layouts, edit weights, and update formats.

## Dashboard

Open **Permissions** in Rune Dashboard to manage groups, rules, grants, player labels, promotion tracks, and channel chat formats. The player profile page checks effective access by world and server. The chat page can preview a template and the tool links to the permissions audit. This page requires Rune 0.5.4 or newer and @rune/dashboard 0.1.2 or newer.

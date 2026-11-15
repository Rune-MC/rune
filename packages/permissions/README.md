# Permissions

Install with `rune add @rune/permissions` and restart Paper. For an
existing installation, run `rune update @rune/storage` before
`rune update @rune/permissions`. Upgrade any installed database adapter as
well. Existing groups, direct memberships, and storage settings still work.

## In-game Permissions Manager

Run `/permissions gui` in game. Players with `rune.admin` can browse the
manager. Editing requires operator status as well.

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
- **Audit and settings** — search the latest 200 data edits and manage the
  local display-name, tab-list, and stacking options. Storage status is visible
  here. To select a backend, set the environment before restarting.

Lists support search and pagination. For rules, right-click the node field
to browse registered permissions. Right-click context and duration fields
for presets. Text fields accept chat input for 60 seconds and suppress the
message while the prompt is active. Type `!cancel` to return to the editor,
or use `/permissions input <text>` to submit through a command.

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

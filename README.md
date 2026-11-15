# Rune

Polyglot scripting platform for Paper Minecraft servers. Write plugins in TypeScript with full Bukkit/Paper API access — no Java, no rebuilds, hot-reloadable.

Python 3 Runes can react to Bukkit event snapshots and register commands using
the optional CPython backend. Install Python on the server or set
`RUNE_PYTHON` to the interpreter's executable path.

```ts
@Listener
export class Welcome {
  @EventHandler(Events.PlayerJoinEvent)
  onJoin(e: PlayerJoinEvent) {
    e.player.sendMessage(
      Component.text(`welcome ${e.player.name}!`).color(NamedColor.GOLD),
    );
  }
}

@Command("give-stick", { permission: "rune.give" })
export class GiveStick {
  @Arg("player", "who to give to", { type: "player" })
  player!: Player;

  @Run
  run(ctx: CommandCtx) {
    this.player.getInventory().addItem(
      rune.itemstack(bukkit.Material.STICK, 1, (m) =>
        m.displayName(Component.text("Wizard's Wand")),
      ),
    );
  }
}
```

## For server admins (just install)

1. Download the platform jar + install bundle from [Releases](../../releases/latest).
2. Run the bootstrap:

   ```powershell
   .\install\install-server.ps1 -ServerPath C:\my-mc
   ```
   ```bash
   ./install/install-server.sh --server ~/my-mc
   ```

3. Start the server. `plugins/Rune/scripts/` is your scripts dir.

The plugin jar contains everything (Rust cdylib + libnode) — no Node install required on the server. See [install/README.md](install/README.md) for full options.

## For contributors (build from source)

Monorepo orchestrated by [turbo](https://turbo.build) on top of `cargo` + `gradle`.

```bash
pnpm install                       # workspace setup
node tools/fetch-libnode.mjs       # download pre-built libnode (~100MB)
pnpm build                         # cargo build + gradle shadowJar via turbo
```

Layout:

```
rune/
├── crates/                    # Rust workspace
│   ├── rune-host-api/         # trait + types shared by backends
│   ├── rune-runtime-node/     # libnode embedding (C++ shim + Rust wrapper)
│   └── rune-loader/           # cdylib loaded via Panama FFM
├── plugin/                    # Paper plugin (Kotlin + Gradle)
├── install/                   # bootstrap scripts shipped with releases
├── tools/                     # build-side scripts (fetch-libnode, etc.)
├── turbo.json                 # task pipeline
└── pnpm-workspace.yaml        # workspaces
```

### libnode

Embedding libnode requires a built Node tree with headers + shared lib. Building from source is multi-hour and 100+ GB of disk; the contributor flow downloads a pre-built tarball from [Rune-MC/libnode-prebuilts](https://github.com/Rune-MC/libnode-prebuilts) via `tools/fetch-libnode.mjs`. Set `RUNE_NODE_ROOT` to override with a local build.

The prebuilts repo's CI builds libnode from source for every supported platform whenever a tag is pushed — see [`tools/libnode-prebuilts-repo/README.md`](tools/libnode-prebuilts-repo/README.md) for the template files to drop into that repo.

### Cutting a release

1. Bump `version` in:
   * `package.json` (root)
   * `Cargo.toml` (workspace.package)
   * `plugin/build.gradle.kts`
2. `git tag v0.x.y && git push --tags`
3. `.github/workflows/release.yml` builds the matrix (Windows/Linux/macOS), bundles install scripts, and publishes a GitHub Release.

## Docs

* `DESIGN_SPEC.md` -- architecture + invariants.
* `install/README.md` -- end-user install + script scaffolding.
* In-game: `/rune help`.
* [Sprint Arena and integration examples](examples/README.md).

### Python

From the server's `plugins/Rune/scripts/` directory, run
`rune init hello-python --language python`, or run `rune new hello-python py`
from the server console. Reload from the console. Restart Paper when adding or
changing a command's name or shape.

```python
from rune import broadcast, on

@on("PlayerJoinEvent")
def welcome(event):
    broadcast(f"Welcome, {event['player']['name']}!")
```

Python workers receive snapshots asynchronously and expose `on`, `command`,
`broadcast`, and `log`. They run as the server user. TypeScript uses the
embedded Node runtime for live JVM interop.

### Adventure and Paper primitives

```typescript
const { adventure } = rune;
rune.on(Events.PlayerJoinEvent, (event) => {
  const player = event.getPlayer();
  const welcome = adventure.format`<gold>Welcome, ${player.getName()}!</gold>`;
  adventure.send(player, welcome);
  adventure.title(player, welcome, "Glad you're here");
});
```

`rune.adventure` includes action bars, sounds, boss bars, tab lists, books,
component formatting, and commonly used Adventure classes. Plain strings stay
literal. Use MiniMessage or the template tag for formatting. Use `rune.types`,
`rune.player`, `rune.world`, `rune.vector`, and `rune.blockAt` for common Paper objects.

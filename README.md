# Rune

Polyglot scripting platform for Paper Minecraft servers. Write plugins in TypeScript with full Bukkit/Paper API access — no Java, no rebuilds, hot-reloadable.

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

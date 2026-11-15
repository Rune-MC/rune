# rune-cli

The author-facing CLI for the [Rune](https://runemc.dev) polyglot
scripting platform. Scaffold, pack, install, and publish Runes from
your shell.

```text
$ rune init my-rune --language python
$ cd my-rune
$ rune check
$ rune pack
```

Prebuilt binaries are available for Windows x64, Linux x64, and Apple Silicon Macs.

## Install

Use the [standalone installer](https://runemc.dev/install) on Windows, macOS,
or Linux. You can scaffold and package projects without a Minecraft server.
From source, build from the workspace root.

```sh
cargo build --release -p rune-cli
# produces target/release/rune[.exe]
```

To install the plugin, stop Paper and run `rune setup` from the server
directory or pass the path as an argument. Start Paper to generate Rune's
config and types. Add `--start` to use your existing launcher.

`rune pack` ships file bytes verbatim — there is no pack-time
transform. The Rune runtime has its own loader-side esbuild that
handles TypeScript, decorators, and JSX at load time, so transforming
twice would just shred readability and tie the published artifact to
a target the runtime is free to bump.

## Commands

| Command | What it does |
|---|---|
| `rune setup [server]` | Installs the plugin and prepares the scripts directory on an existing Paper server. |
| `rune init [dir]` | Scaffolds a project in TypeScript, JavaScript, or Python. |
| `rune check` | Validates the manifest and checks whether the entry point will be packed. |
| `rune pack` | Walks the project, hashes every file, writes the manifest + per-blob files + a `*.tar.zst` archive to `dist/`. |
| `rune publish` | Runs `pack`, then uploads missing blobs to R2 and finalises the version on Runebook. |
| `rune add <spec>` | Installs a published Rune into a server's `plugins/Rune/scripts/`. Aliased as `rune install`. |
| `rune remove <name>` | Uninstalls a previously-installed Rune. Aliased as `rune uninstall`. |
| `rune list` | Lists packages that the CLI installed, including their version and registry. |
| `rune update [name]` | Updates installed packages. |
| `rune update-cli` | Updates the CLI from GitHub Releases. |
| `rune login` | Opens a browser on a desktop. On a headless host, prints a link and code to finish on another device. |
| `rune logout` | Removes the saved token. |
| `rune whoami` | Probes `/api/v1/whoami` for each saved token; prints username + scopes. |

Add `--verbose` to any command for DEBUG-level tracing on stderr.

Use `rune login --device` to sign in from another device even on a desktop.
For automation, use `rune login --token <PAT>` or set `RUNE_TOKEN` before running
`rune login`. Browser-issued credentials expire after 30 days.

## Environment variables

The CLI loads a `.env` file walking up from the current directory
before parsing args, so a per-project file is enough for local dev.
Process-level env always wins over `.env` — CI workflows aren't
overridden by an accidentally-committed `.env`.

| Variable | Used by | Purpose |
|---|---|---|
| `RUNEBOOK_URL` | `publish`, `login`, `whoami`, `add` | Registry base URL. Defaults to `https://runemc.dev`. Set to `http://localhost:3000` to publish against a local dev instance of the website. |
| `RUNE_SCRIPTS` | `add`, `remove` | Path to a server's `plugins/Rune/scripts/` (or a server root containing one). Skips the auto-detection of cwd. |
| `RUNE_SERVER` | `setup` | Server directory when no argument is supplied. |
| `RUNE_CONFIG_DIR` | Runebook commands | Override Rune's per-user credential directory. |

Example `.env` for working against a local Runebook:

```ini
RUNEBOOK_URL=http://localhost:3000
```

## File layout

```
crates/rune-cli/
├── Cargo.toml
├── README.md                  ← you are here
└── src/
    ├── main.rs                ← entrypoint + .env load + tracing
    ├── cli.rs                 ← clap derives for every subcommand
    ├── auth.rs                ← ~/.config/rune/token store
    ├── config.rs              ← rune.toml parser + validation
    ├── hash.rs                ← SHA-256 helpers (the security boundary)
    ├── ignore_filter.rs       ← include / deny / exclude / .runeignore
    ├── manifest.rs            ← Manifest type + canonical-JSON serialiser
    ├── registry.rs            ← Runebook HTTP client (the API contract)
    └── commands/
        ├── add.rs             ← rune add <spec>
        ├── init.rs
        ├── install_dir.rs     ← shared: scripts-dir resolution + lockfile
        ├── login.rs
        ├── logout.rs
        ├── pack.rs
        ├── publish.rs
        ├── remove.rs          ← rune remove <name>
        └── whoami.rs
```

The CLI's manifest schema and the website's manifest validation are
mirror images of each other. When one changes, the other must follow
in the same release — see `Projects/rune-website/SPEC.md` §5 for the
website-side source of truth.

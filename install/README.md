# Rune install scripts

> Easiest path: download the install bundle from the [latest GitHub Release](../../releases/latest). The zip contains everything below plus a pre-built plugin jar for your platform.

---


Two scripts per platform:

| Script             | What it does                                                                  |
| ------------------ | ----------------------------------------------------------------------------- |
| `install-server.*` | Bootstraps a Paper server + drops in the Rune plugin.                         |
| `new-script.*`     | Scaffolds a new script folder under `plugins/Rune/scripts/<name>/`.           |

PowerShell variants are for Windows; `.sh` variants for Linux/macOS.

---

## First time: install a server with Rune

Drop the bundled `rune-<version>.jar` next to this README (or pass `--rune /path/to/jar`), then:

**Windows**

```powershell
.\install-server.ps1 -ServerPath C:\my-mc-server
```

**Linux / macOS**

```bash
./install-server.sh --server ~/my-mc-server
```

The script will:

1. Verify Java 21+ is on `PATH`.
2. Download the latest Paper build for `--paper 1.21.4` (override with `--paper 1.21.5` etc.).
3. Write `eula.txt` (`eula=true`) into the server folder.
4. Copy the bundled `rune-*.jar` into `plugins/`.
5. Print the command to start the server.

Add `--start` (or `-Start` on PowerShell) to also boot the server once so it can bootstrap `plugins/Rune/scripts/` and the type definitions.

---

## Scaffold a new script folder

```powershell
.\new-script.ps1 -Name greeter -ServerPath C:\my-mc-server
```

```bash
./new-script.sh --name greeter --server ~/my-mc-server
```

Creates `plugins/Rune/scripts/greeter/` with:

* `index.ts` -- entry point with a starter `rune.on(Events.PlayerJoinEvent, ...)` handler.
* `rune.jsonc` -- placeholder for plugin deps + aliases.

Run `/rune reload` in-game to load it (or restart the server).

---

## Languages

Currently shipped:

| `--lang` | Runtime              | Notes                                          |
| -------- | -------------------- | ---------------------------------------------- |
| `ts`     | Node.js + TypeScript | Default. Includes Stage-3 decorator support.   |

Planned (template tree under `templates/<lang>/` makes adding new runtimes a copy-the-folder job):

* `py`  -- Python via embedded interpreter
* `lua` -- Lua via embedded interpreter
* `rs`  -- Rust/Wasm via the existing `rune-runtime-wasm` crate

> Deno is **not** supported anymore; the runtime is libnode-backed.

---

## Custom flags

`install-server.*`:

| Flag                | Default        |
| ------------------- | -------------- |
| `--server` / `-ServerPath` | `.`     |
| `--paper`  / `-PaperVersion` | `1.21.4` |
| `--rune`   / `-RuneJar`     | auto-locate |
| `--start`  / `-Start`       | off     |

`new-script.*`:

| Flag                | Default |
| ------------------- | ------- |
| `--name`   / `-Name`        | (required) |
| `--lang`   / `-Lang`        | `ts`    |
| `--server` / `-ServerPath`  | `.`     |

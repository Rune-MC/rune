use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

/// Rune — polyglot scripting for Paper Minecraft servers.
///
/// Use this CLI to scaffold new Runes, pack them into a publishable
/// archive, and publish to the Runebook at https://runemc.dev.
#[derive(Parser, Debug)]
#[command(name = "rune", version, about, long_about = None)]
pub struct Cli {
    /// More verbose log output (DEBUG instead of INFO).
    #[arg(long, short, global = true)]
    pub verbose: bool,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// Scaffold a new Rune project in the current directory.
    Init(InitArgs),

    /// Build a publishable archive locally without uploading.
    Pack(PackArgs),

    /// Pack and publish a Rune to the Runebook.
    Publish(PublishArgs),

    /// Save a Runebook personal access token to ~/.config/rune/token.
    Login(LoginArgs),

    /// Forget the saved Runebook token.
    Logout,

    /// Show the username the saved token belongs to.
    Whoami,

    /// Install a published Rune into a Minecraft server's scripts folder.
    #[command(alias = "install")]
    Add(AddArgs),

    /// Remove an installed Rune from a Minecraft server's scripts folder.
    #[command(alias = "uninstall")]
    Remove(RemoveArgs),

    /// Bring every installed Rune up to its latest registry version.
    #[command(alias = "upgrade")]
    Update(UpdateArgs),

    /// Self-update the `rune` binary from the project's GitHub releases.
    #[command(alias = "upgrade-cli", alias = "self-update")]
    UpdateCli(UpdateCliArgs),
}

#[derive(Args, Debug)]
pub struct InitArgs {
    /// Name to write into `rune.toml`. Defaults to the directory name,
    /// lowercased + hyphenated. Scope (e.g. `@alice/foo`) is added later
    /// by editing the file — `rune init` doesn't claim a scope for you.
    #[arg(long)]
    pub name: Option<String>,

    /// Language for the entry point template.
    #[arg(long, default_value = "typescript")]
    pub language: Language,

    /// Overwrite files if they already exist.
    #[arg(long)]
    pub force: bool,

    /// Project directory. Defaults to the current directory.
    #[arg(default_value = ".")]
    pub dir: PathBuf,
}

#[derive(clap::ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Language {
    Typescript,
    Wasm,
}

impl Language {
    pub fn manifest_value(self) -> &'static str {
        match self {
            Language::Typescript => "typescript",
            Language::Wasm => "wasm",
        }
    }
}

#[derive(Args, Debug)]
pub struct PackArgs {
    /// Project directory containing `rune.toml`. Defaults to the current
    /// directory; walks UP to find the nearest `rune.toml` if not direct.
    #[arg(long, default_value = ".")]
    pub dir: PathBuf,

    /// Where to write the packed archive + manifest. The manifest lands
    /// at `<out>/<name>-<version>.manifest.json`; per-file blobs and the
    /// zstd-compressed archive land alongside.
    #[arg(long, default_value = "dist")]
    pub out: PathBuf,
}

#[derive(Args, Debug)]
pub struct PublishArgs {
    #[command(flatten)]
    pub pack: PackArgs,

    /// Override the Runebook registry URL. Used by tests and against a
    /// local dev instance of the website.
    #[arg(long, env = "RUNEBOOK_URL", default_value = "https://runemc.dev")]
    pub registry: url::Url,

    /// Skip the confirmation prompt and publish immediately. Useful in
    /// CI; otherwise the CLI shows what's about to be published and asks.
    #[arg(long, short)]
    pub yes: bool,

    /// Mark the version as a draft (yanked on publish). Lets authors test
    /// the publish flow end-to-end without polluting the default
    /// resolver. Drafts are still installable by hash for verification.
    #[arg(long)]
    pub draft: bool,

    /// Publish the rune as private (visible only to the owner / org
    /// members). Honored only on the FIRST publish — visibility changes
    /// to existing runes go through the website. Mutually exclusive with
    /// --public; if neither is set, the registry default (public) wins.
    #[arg(long, conflicts_with = "public")]
    pub private: bool,

    /// Explicit opposite of --private — sets the new rune to public.
    /// Identical to passing nothing (the registry already defaults to
    /// public), but lets CI scripts be unambiguous.
    #[arg(long)]
    pub public: bool,
}

#[derive(Args, Debug)]
pub struct AddArgs {
    /// Rune to install, optionally pinned to a version: `ward` or
    /// `ward@0.1.0` or `@alice/foo@^1.2`. Without an `@version`, the
    /// registry's latest released version is used.
    pub spec: String,

    /// Path to the Minecraft server root (the folder that contains
    /// `plugins/Rune/scripts/`). Defaults to `RUNE_SCRIPTS`, then the
    /// current directory if it looks like a server root.
    #[arg(long, env = "RUNE_SCRIPTS")]
    pub scripts: Option<PathBuf>,

    /// Override the Runebook registry URL.
    #[arg(long, env = "RUNEBOOK_URL", default_value = "https://runemc.dev")]
    pub registry: url::Url,

    /// Overwrite an existing install at the same target dir. Refuses
    /// without this flag when the directory already exists.
    #[arg(long)]
    pub force: bool,

    /// Skip installing the Rune's `[dependencies]`. By default `rune
    /// add` walks the dep graph from rune.toml and installs every
    /// missing dep into the same scripts folder. Use this when you
    /// want a one-off install and intend to manage deps yourself.
    #[arg(long)]
    pub no_deps: bool,
}

#[derive(Args, Debug)]
pub struct UpdateCliArgs {
    /// Check for a new release but don't actually install. Useful for
    /// scripts that want to know whether an upgrade is available.
    #[arg(long)]
    pub check: bool,
}

#[derive(Args, Debug)]
pub struct UpdateArgs {
    /// Limit the update to a single Rune (matches against the canonical
    /// name OR the unscoped basename of the install dir). Without it,
    /// every installed Rune is checked.
    pub name: Option<String>,

    /// Path to the Minecraft server root or scripts dir. Same resolution
    /// as `rune add`.
    #[arg(long, env = "RUNE_SCRIPTS")]
    pub scripts: Option<PathBuf>,

    /// Override the Runebook registry URL.
    #[arg(long, env = "RUNEBOOK_URL", default_value = "https://runemc.dev")]
    pub registry: url::Url,
}

#[derive(Args, Debug)]
pub struct RemoveArgs {
    /// Name of the Rune to remove. Scope is optional; the install
    /// folder is keyed by the unscoped basename either way.
    pub name: String,

    /// Path to the Minecraft server root, same resolution as `rune add`.
    #[arg(long, env = "RUNE_SCRIPTS")]
    pub scripts: Option<PathBuf>,

    /// Skip the confirmation prompt.
    #[arg(long, short)]
    pub yes: bool,
}

#[derive(Args, Debug)]
pub struct LoginArgs {
    /// Token to save. If omitted, prompts on stdin. Either way the value
    /// is written to ~/.config/rune/token with 0o600 perms.
    #[arg(long)]
    pub token: Option<String>,

    /// Override the registry whose token this is. The token file stores
    /// `(registry, token)` pairs so a user can log in to a dev registry
    /// without losing their prod credentials.
    #[arg(long, env = "RUNEBOOK_URL", default_value = "https://runemc.dev")]
    pub registry: url::Url,
}

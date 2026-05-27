use clap::Parser;

mod auth;
mod cli;
mod commands;
mod config;
mod hash;
mod ignore_filter;
mod manifest;
mod registry;

use cli::{Cli, Command};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Walk up from the current directory looking for a `.env` and load
    // its vars BEFORE clap reads them. Existing process env always wins,
    // so `RUNEBOOK_URL=http://localhost:3000 rune publish` still works
    // even when a stale `.env` is present. Common use case: a Runebook
    // dev checkout drops `.env` containing the dev-server URL so every
    // `rune publish` against that tree just works.
    let _ = dotenvy::dotenv();

    let cli = Cli::parse();

    // Verbose mode swaps INFO → DEBUG on the tracing subscriber. CLI output
    // (the stuff the user actually reads) goes through println!/eprintln!
    // and uses the `console` crate for colour; tracing is for the
    // structured debug-when-things-break audience.
    let level = if cli.verbose { "debug" } else { "info" };
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(format!("rune_cli={level},warn")));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .without_time()
        .with_target(false)
        .init();

    let result = match cli.command {
        Command::Init(args) => commands::init::run(args).await,
        Command::Pack(args) => commands::pack::run(args).await,
        Command::Publish(args) => commands::publish::run(args).await,
        Command::Login(args) => commands::login::run(args).await,
        Command::Logout => commands::logout::run().await,
        Command::Whoami => commands::whoami::run().await,
        Command::Add(args) => commands::add::run(args).await,
        Command::Remove(args) => commands::remove::run(args).await,
        Command::Update(args) => commands::update::run(args).await,
    };

    if let Err(err) = result {
        // anyhow formats the whole error chain; the leading `error:` makes
        // it unmistakable even when stderr is interleaved with stdout in a
        // pipeline. Exit 1 so shells short-circuit `&&` chains.
        eprintln!("{} {:#}", console::style("error:").red().bold(), err);
        std::process::exit(1);
    }
    Ok(())
}

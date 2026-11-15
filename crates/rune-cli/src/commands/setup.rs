use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, ensure, Context, Result};

use crate::cli::SetupArgs;

use super::{install_dir, release};

pub async fn run(args: SetupArgs) -> Result<()> {
    let server = match args.server {
        Some(path) => {
            let server = std::path::absolute(&path)
                .with_context(|| format!("opening Paper server folder {}", path.display()))?;
            ensure!(server.is_dir(), "server path is not a directory: {}", path.display());
            server
        }
        None => find_server(&std::env::current_dir()?)
            .context("no Paper server found here. Run `rune setup <path-to-server>` with the folder that contains your server jar.")?,
    };
    let jar_path = args
        .jar
        .map(|path| {
            ensure!(
                path.is_file(),
                "Rune plugin jar not found: {}",
                path.display()
            );
            Ok(path)
        })
        .transpose()?;
    let launcher = if args.start {
        Some(launcher(&server)?)
    } else {
        None
    };
    println!("Paper server at {}", server.display());

    let plugins = server.join("plugins");
    fs::create_dir_all(&plugins)?;
    let guard = install_dir::lock_directory(&plugins)?;
    let stage = tempfile::Builder::new()
        .prefix(".rune-setup-")
        .tempdir_in(&plugins)?;
    let staged_jar = stage.path().join("plugin.jar");

    let name = if let Some(jar_path) = jar_path {
        fs::copy(&jar_path, &staged_jar)
            .with_context(|| format!("copying {}", jar_path.display()))?;
        "rune.jar".to_owned()
    } else {
        let platform = release::platform()?;
        let release = release::fetch(args.version.as_deref()).await?;
        let name = format!("rune-{}-{platform}.jar", release.version());
        println!("Downloading {name}");
        release.asset(&name)?.download(&staged_jar).await?;
        name
    };

    let scripts = plugins.join("Rune/scripts");
    fs::create_dir_all(&scripts).with_context(|| format!("creating {}", scripts.display()))?;
    let destination = plugins.join(name);
    install_plugin(stage, &staged_jar, &destination, &plugins)?;
    drop(guard);
    println!("Installed {}", destination.display());
    println!("Scripts directory at {}", scripts.display());

    if let Some(mut launcher) = launcher {
        println!("Starting Paper. Rune will initialize during startup.");
        let status = launcher.status().context("running the server launcher")?;
        ensure!(status.success(), "server launcher exited with {status}");
    } else {
        println!("Start or restart Paper to generate Rune's config and type definitions.");
        println!("Run `rune status` in the Paper console to verify the plugin loaded.");
    }
    Ok(())
}

fn find_server(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .find(|dir| {
            dir.join("server.properties").is_file()
                || dir.join("paper.jar").is_file()
                || dir.join("purpur.jar").is_file()
                || dir.join("folia.jar").is_file()
                || dir.join("server.jar").is_file()
                || fs::read_dir(dir)
                    .into_iter()
                    .flatten()
                    .filter_map(Result::ok)
                    .any(|entry| {
                        let name = entry.file_name();
                        let name = name.to_string_lossy();
                        name.ends_with(".jar")
                            && ["paper-", "purpur-", "folia-"]
                                .iter()
                                .any(|prefix| name.starts_with(prefix))
                            && entry.path().is_file()
                    })
        })
        .map(Path::to_path_buf)
}

fn is_rune_jar(name: &str) -> bool {
    if name.eq_ignore_ascii_case("rune.jar") {
        return true;
    }
    let Some(stem) = name
        .strip_prefix("rune-")
        .and_then(|rest| rest.strip_suffix(".jar"))
    else {
        return false;
    };
    let version = release::PLATFORMS
        .iter()
        .find_map(|platform| {
            stem.strip_suffix(platform)
                .and_then(|rest| rest.strip_suffix('-'))
        })
        .unwrap_or(stem);
    semver::Version::parse(version).is_ok()
}

fn install_plugin(
    stage: tempfile::TempDir,
    jar: &Path,
    destination: &Path,
    plugins: &Path,
) -> Result<()> {
    let backup_dir = stage.path().join("previous");
    fs::create_dir(&backup_dir)?;
    let mut previous_jars = Vec::new();
    for entry in fs::read_dir(plugins)? {
        let entry = entry?;
        if entry.file_type()?.is_file() && is_rune_jar(&entry.file_name().to_string_lossy()) {
            previous_jars.push(entry.path());
        }
    }

    let mut moved = Vec::new();
    let result = (|| -> Result<()> {
        for path in previous_jars {
            let backup = backup_dir.join(path.file_name().context("plugin path has no filename")?);
            fs::rename(&path, &backup).with_context(|| {
                format!(
                    "moving {} aside; stop your server before setup",
                    path.display()
                )
            })?;
            moved.push((path, backup));
        }
        fs::rename(jar, destination)
            .with_context(|| format!("installing {}", destination.display()))
    })();

    if let Err(error) = result {
        let mut restore_errors = Vec::new();
        for (path, backup) in moved {
            if let Err(restore_error) = fs::rename(&backup, &path) {
                restore_errors.push(format!("{}: {restore_error}", path.display()));
            }
        }
        if !restore_errors.is_empty() {
            let preserved = stage.keep().join("previous");
            bail!(
                "{error:#}. Restore the previous jars from {}: {}",
                preserved.display(),
                restore_errors.join(", ")
            );
        }
        return Err(error);
    }
    Ok(())
}

fn launcher(server: &Path) -> Result<Command> {
    let candidates: &[&str] = if cfg!(windows) {
        &[
            "start.ps1",
            "start.bat",
            "start.cmd",
            "run.ps1",
            "run.bat",
            "run.cmd",
        ]
    } else {
        &["start.sh", "run.sh", "start.command", "run.command"]
    };
    let script = candidates
        .iter()
        .map(|name| server.join(name))
        .find(|path| path.is_file())
        .context(
            "no start script found; run setup without --start and use your normal Paper launcher",
        )?;
    let mut command = match script.extension().and_then(|ext| ext.to_str()) {
        Some("ps1") => {
            let mut command = Command::new("powershell");
            command.args(["-NoProfile", "-File"]).arg(script);
            command
        }
        Some("bat" | "cmd") => Command::new(script),
        _ => {
            let mut command = Command::new("bash");
            command.arg(script);
            command
        }
    };
    command.current_dir(server);
    Ok(command)
}

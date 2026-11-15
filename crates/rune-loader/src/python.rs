use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use std::time::{Duration, Instant};

use rune_host_api::{HostCommand, LanguageRuntime, RuntimeError};
use serde::Deserialize;
use serde_json::{Value, json};

const BOOTSTRAP: &str = include_str!("python_bootstrap.py");
const STARTUP_TIMEOUT: Duration = Duration::from_secs(2);
const QUEUE_SIZE: usize = 128;
const MAX_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Default)]
pub struct PythonBackend {
    scripts: HashMap<PathBuf, Worker>,
    pending: Vec<HostCommand>,
}

struct Worker {
    child: Child,
    send: SyncSender<Vec<u8>>,
    receive: Receiver<Message>,
    events: HashSet<String>,
    overrun: bool,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Message {
    Ready { ready: bool },
    Command(HostCommand),
}

impl Worker {
    fn spawn(path: &Path) -> Result<Self, RuntimeError> {
        let interpreter = std::env::var_os("RUNE_PYTHON").unwrap_or_else(|| {
            if cfg!(windows) { "python".into() } else { "python3".into() }
        });
        let mut process = Command::new(&interpreter);
        process
            .args(["-I", "-u", "-c", BOOTSTRAP])
            .arg(path)
            .current_dir(path.parent().expect("canonical script has a parent"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            process.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = process.spawn().map_err(|error| {
            RuntimeError::Load(format!(
                "could not launch {:?}: {error}. Install Python or set RUNE_PYTHON.",
                interpreter
            ))
        })?;
        let mut stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let (send, outbound) = sync_channel::<Vec<u8>>(QUEUE_SIZE);
        let (inbound, receive) = sync_channel(QUEUE_SIZE);

        std::thread::spawn(move || {
            while let Ok(data) = outbound.recv() {
                if stdin.write_all(&data).and_then(|()| stdin.write_all(b"\n")).is_err() {
                    break;
                }
            }
        });
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                match reader.by_ref().take(MAX_FRAME_BYTES as u64).read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) if !line.ends_with('\n') => break,
                    _ => {}
                }
                match serde_json::from_str(&line) {
                    Ok(message) => {
                        if inbound.send(message).is_err() {
                            break;
                        }
                    }
                    _ => break,
                }
            }
        });
        Ok(Self {
            child,
            send,
            receive,
            events: HashSet::new(),
            overrun: false,
        })
    }

    fn track(&mut self, command: &HostCommand) {
        match command {
            HostCommand::SubscribeEvent { name, priority } => {
                self.events.insert(format!("{name}#{}", priority.as_deref().unwrap_or("NORMAL")));
            }
            HostCommand::RegisterCommand(spec) => {
                self.events.insert(format!("__rune_command:{}", spec.name));
            }
            _ => {}
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl LanguageRuntime for PythonBackend {
    fn name(&self) -> &'static str { "python" }

    fn extensions(&self) -> &[&'static str] { &["py"] }

    fn load_script(&mut self, path: &Path) -> Result<(), RuntimeError> {
        let path = path.canonicalize()?;
        if self.scripts.contains_key(&path) {
            return Ok(());
        }
        let mut worker = Worker::spawn(&path)?;
        let deadline = Instant::now() + STARTUP_TIMEOUT;
        let mut startup = Vec::new();
        loop {
            let timeout = deadline.saturating_duration_since(Instant::now());
            if timeout.is_zero() {
                return Err(RuntimeError::Load("Python startup timed out".into()));
            }
            match worker.receive.recv_timeout(timeout) {
                Ok(Message::Ready { ready: true }) => break,
                Ok(Message::Command(HostCommand::Log { level, message, .. })) if level == "error" => {
                    log::error!("{}: {message}", path.display());
                }
                Ok(Message::Command(command)) if startup.len() < QUEUE_SIZE => {
                    worker.track(&command);
                    startup.push(command);
                }
                Ok(Message::Command(_)) => {
                    return Err(RuntimeError::Load("Python startup emitted too many operations".into()));
                }
                _ => return Err(RuntimeError::Load("Python exited or failed to initialize".into())),
            }
        }
        self.pending.extend(startup);
        self.scripts.insert(path, worker);
        Ok(())
    }

    fn dispatch_event(&mut self, name: &str, payload: &[u8]) -> Result<(), RuntimeError> {
        let key = if name.starts_with("__rune_command:") || name.contains('#') {
            name.to_owned()
        } else {
            format!("{name}#NORMAL")
        };
        if !self.scripts.values().any(|worker| worker.events.contains(&key)) {
            return Ok(());
        }
        let data = if payload.is_empty() {
            Value::Null
        } else {
            ciborium::from_reader(payload).map_err(|err| RuntimeError::Dispatch(format!("{err}")))?
        };
        let frame = serde_json::to_vec(&json!({ "event": key, "data": data }))
            .map_err(|err| RuntimeError::Dispatch(err.to_string()))?;
        if frame.len() >= MAX_FRAME_BYTES {
            return Err(RuntimeError::Dispatch("Python event exceeds 1 MiB".into()));
        }
        for (path, worker) in &mut self.scripts {
            if !worker.events.contains(&key) {
                continue;
            }
            match worker.send.try_send(frame.clone()) {
                Ok(()) => worker.overrun = false,
                Err(TrySendError::Full(_)) if !worker.overrun => {
                    worker.overrun = true;
                    log::warn!("{}: Python event queue is full, dropping events", path.display());
                }
                Err(_) => {}
            }
        }
        Ok(())
    }

    fn reload(&mut self) -> Result<(), RuntimeError> {
        let paths: Vec<_> = self.scripts.keys().cloned().collect();
        self.scripts.clear();
        self.pending.clear();
        for path in paths.into_iter().filter(|path| path.is_file()) {
            if let Err(error) = self.load_script(&path) {
                log::error!("reload {}: {error}", path.display());
            }
        }
        Ok(())
    }

    fn drain_commands(&mut self) -> Vec<HostCommand> {
        for worker in self.scripts.values_mut() {
            for _ in 0..QUEUE_SIZE {
                let Ok(message) = worker.receive.try_recv() else { break };
                if let Message::Command(command) = message {
                    worker.track(&command);
                    self.pending.push(command);
                }
            }
        }
        self.scripts.retain(|path, worker| match worker.child.try_wait() {
            Ok(Some(status)) => {
                log::warn!("{}: Python exited ({status})", path.display());
                false
            }
            _ => true,
        });
        std::mem::take(&mut self.pending)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires Python on PATH or RUNE_PYTHON"]
    fn python_receives_event_and_reloads() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("index.py");
        std::fs::write(&path, include_str!("../../../install/templates/py/index.py")).unwrap();
        let mut runtime = PythonBackend::default();
        runtime.load_script(&path).unwrap();
        let mut payload = Vec::new();
        ciborium::into_writer(&json!({"player": {"name": "Alex"}}), &mut payload).unwrap();
        for _ in 0..2 {
            assert!(runtime.drain_commands().iter().any(|command| matches!(
                command, HostCommand::SubscribeEvent { name, .. } if name == "PlayerJoinEvent"
            )));
            runtime.dispatch_event("PlayerJoinEvent#NORMAL", &payload).unwrap();
            let deadline = Instant::now() + Duration::from_secs(1);
            loop {
                if runtime.drain_commands().iter().any(|command| matches!(
                    command, HostCommand::Broadcast { message } if message == "Welcome, Alex!"
                )) {
                    break;
                }
                assert!(Instant::now() < deadline, "expected the Python welcome broadcast");
                std::thread::sleep(Duration::from_millis(10));
            }
            runtime.reload().unwrap();
        }
    }
}

//! Unix socket the `murmo hook` client talks to. Missing socket → the client
//! prints continue, so IDE/`exec` Codex is never blocked.

use std::io::{Read, Write};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;

use serde_json::{json, Value};

use crate::engine::Engine;

pub const SOCKET_ENV: &str = "MURMO_HOOK_SOCKET";

pub struct HookServer {
    listener: UnixListener,
    pub path: PathBuf,
}

impl HookServer {
    pub fn bind() -> Option<Self> {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("murmo-hook-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).ok()?;
        listener.set_nonblocking(true).ok()?;
        std::env::set_var(SOCKET_ENV, &path);
        Some(HookServer { listener, path })
    }

    pub fn fd(&self) -> i32 {
        self.listener.as_raw_fd()
    }

    pub fn serve_ready(&self, engine: &Engine) {
        loop {
            match self.listener.accept() {
                Ok((stream, _)) => reply(stream, engine),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(_) => break,
            }
        }
    }
}

impl Drop for HookServer {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn reply(mut stream: UnixStream, engine: &Engine) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(40)));
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    loop {
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if buf.contains(&b'\n') {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let line = String::from_utf8_lossy(&buf).trim().to_string();
    let out = engine
        .call("__hook", &line)
        .unwrap_or_else(|_| json_continue(&line));
    let mut body = out;
    if !body.ends_with('\n') {
        body.push('\n');
    }
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

fn json_continue(line: &str) -> String {
    let event = serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|v| {
            v.get("hook_event_name")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "PreToolUse".into());
    json!({
        "hookSpecificOutput": {
            "hookEventName": event,
            "permissionDecision": "allow"
        }
    })
    .to_string()
}

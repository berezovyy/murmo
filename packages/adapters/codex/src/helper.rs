//! Client for `murmo-plugin-host` over stdio. Third-party plugins only; a miss
//! turns that feature off, never the built-ins.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::{json, Value};

pub struct Helper {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    rx: Receiver<String>,
    next_id: u64,
}

impl Helper {
    pub fn spawn(bin: &Path) -> Result<Self, String> {
        let mut child = Command::new(bin)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        let stdin = child.stdin.take().ok_or("helper stdin")?;
        let stdout = child.stdout.take().ok_or("helper stdout")?;
        let mut reader = BufReader::new(stdout);
        let mut ready = String::new();
        reader.read_line(&mut ready).map_err(|e| e.to_string())?;
        let v: Value = serde_json::from_str(&ready).map_err(|e| e.to_string())?;
        if v["protocol"] != 1 || v["apiVersion"] != "2.0.0" {
            let _ = child.kill();
            return Err("helper protocol mismatch".into());
        }
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        if tx.send(line).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Helper {
            child,
            stdin: Arc::new(Mutex::new(stdin)),
            rx,
            next_id: 0,
        })
    }

    pub fn writer(&self) -> Arc<Mutex<ChildStdin>> {
        self.stdin.clone()
    }

    pub fn send_line(&self, line: &str) -> Result<(), String> {
        let mut g = self.stdin.lock().map_err(|e| e.to_string())?;
        writeln!(g, "{line}").map_err(|e| e.to_string())?;
        g.flush().map_err(|e| e.to_string())
    }

    pub fn try_recv(&self) -> Vec<String> {
        let mut out = Vec::new();
        while let Ok(line) = self.rx.try_recv() {
            out.push(line);
        }
        out
    }

    pub fn next_id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    pub fn hello(&mut self) -> Result<(), String> {
        let id = self.next_id();
        self.send_line(
            &json!({"op":"hello","id":id,"protocol":1,"apiVersion":"2.0.0"}).to_string(),
        )?;
        Ok(())
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.send_line(r#"{"op":"shutdown"}"#);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn resolve_helper(self_exe: &Path) -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("MURMO_PLUGIN_HOST") {
        return Some(PathBuf::from(p));
    }
    if let Some(dir) = self_exe.parent() {
        let next = dir.join("murmo-plugin-host");
        if next.is_file() {
            return Some(next);
        }
    }
    None
}

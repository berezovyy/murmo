//! One supervisor per agent session: serial queue per plugin, one worker
//! process each, shared first-party group.

use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Write};
use std::os::fd::AsRawFd;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Instant;

use serde_json::{json, Value};

use crate::config::{handle as config_handle, is_config_op};
use crate::faults::{error_reply, FaultKind};
use crate::limits::{watchdog_ms, INIT_WAIT_MS};
use crate::names::{handle as names_handle, is_names_op};
use crate::protocol::{line_too_large, ready_message};
use crate::store::{handle as store_handle, is_store_op};

fn reply_stdout(v: &Value) {
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

fn current_exe() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| e.to_string())
}

struct Worker {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    metadata: Value,
    members: Value,
}

impl Worker {
    fn spawn(cfg: &Value) -> Result<Self, String> {
        let exe = current_exe()?;
        let sandboxed = cfg.get("sandbox").and_then(Value::as_bool).unwrap_or(false);
        let mut child = crate::sandbox::spawn_worker(&exe, sandboxed)?;
        let mut input = child.stdin.take().ok_or("worker stdin")?;
        let mut output = BufReader::new(child.stdout.take().ok_or("worker stdout")?);
        writeln!(input, "{cfg}").map_err(|e| e.to_string())?;
        input.flush().map_err(|e| e.to_string())?;
        let reply = read_line(&mut output, INIT_WAIT_MS)?;
        if reply.get("status").and_then(Value::as_str) != Some("ok") {
            let _ = child.kill();
            let _ = child.wait();
            return Err(reply
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or(&reply.to_string())
                .to_string());
        }
        Ok(Worker {
            metadata: reply.get("metadata").cloned().unwrap_or(Value::Null),
            members: reply.get("members").cloned().unwrap_or(Value::Null),
            child,
            input,
            output,
        })
    }

    fn request(&mut self, q: &Value, timeout_ms: u64) -> Result<Value, String> {
        writeln!(self.input, "{q}").map_err(|e| e.to_string())?;
        self.input.flush().map_err(|e| e.to_string())?;
        read_line(&mut self.output, timeout_ms)
    }

    fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    fn pid(&self) -> u32 {
        self.child.id()
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.stop();
    }
}

fn read_line(output: &mut BufReader<ChildStdout>, timeout_ms: u64) -> Result<Value, String> {
    let fd = output.get_ref().as_raw_fd();
    let mut poll = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: poll waits on this worker's stdout only.
    let ready = unsafe { libc::poll(&mut poll, 1, timeout_ms.min(i32::MAX as u64) as i32) };
    if ready <= 0 {
        return Err("supervisor timeout".into());
    }
    let mut line = String::new();
    output.read_line(&mut line).map_err(|e| e.to_string())?;
    if line.is_empty() {
        return Err("guest worker exited".into());
    }
    serde_json::from_str(&line).map_err(|e| e.to_string())
}

struct Slot {
    config: Value,
    worker: Option<Worker>,
    generation: u64,
    restarts: u64,
}

impl Slot {
    fn call(&mut self, q: &Value) -> Value {
        let t = Instant::now();
        if self.worker.is_none() {
            match Worker::spawn(&self.config) {
                Ok(w) => self.worker = Some(w),
                Err(e) => return error_reply(FaultKind::Transport, &e),
            }
        }
        let timeout = watchdog_ms(q.get("deadlineMs").and_then(Value::as_u64).unwrap_or(5));
        let mut request = q.clone();
        let result = loop {
            let result = match self.worker.as_mut() {
                Some(w) => w.request(&request, timeout),
                None => return error_reply(FaultKind::Transport, "plugin worker is down"),
            };
            match result {
                Ok(row) if row.get("status").and_then(Value::as_str) == Some("broker") => {
                    if let Some(replies) = fulfill_helper(&self.config, &row) {
                        request = q.clone();
                        request["resume"] = json!(true);
                        request["replies"] = replies;
                        continue;
                    }
                    break Ok(row);
                }
                other => break other,
            }
        };
        let failed = result
            .as_ref()
            .map(|r| {
                let status = r.get("status").and_then(Value::as_str).unwrap_or("");
                status != "ok" && status != "broker"
            })
            .unwrap_or(true);
        let mut out = result.unwrap_or_else(|e| {
            let kind = if e == "supervisor timeout" {
                FaultKind::WallTimeout
            } else if e == "guest worker exited" {
                FaultKind::SessionExit
            } else {
                FaultKind::Transport
            };
            error_reply(kind, &e)
        });
        if failed {
            self.worker.take();
            self.restarts += 1;
            self.generation += 1;
            match Worker::spawn(&self.config) {
                Ok(w) => {
                    self.worker = Some(w);
                    out["restarted"] = json!(true);
                    out["stateReset"] = json!(true);
                }
                Err(e) => out["restartError"] = json!(e),
            }
        }
        if out.get("status").and_then(Value::as_str) == Some("error") && out.get("kind").is_none() {
            out["kind"] = json!(FaultKind::Plugin.as_str());
        }
        out["generation"] = json!(self.generation);
        out["restarts"] = json!(self.restarts);
        out["supervisorMs"] = json!(t.elapsed().as_secs_f64() * 1000.0);
        out
    }
}

struct Entry {
    control: Arc<Mutex<u64>>,
    active: Arc<AtomicU64>,
    pid: Arc<AtomicU32>,
    slot: Arc<Mutex<Slot>>,
    tx: Option<mpsc::Sender<Value>>,
    runner: Option<std::thread::JoinHandle<()>>,
}

impl Drop for Entry {
    fn drop(&mut self) {
        self.tx.take();
        if let Some(t) = self.runner.take() {
            let _ = t.join();
        }
    }
}

pub struct Supervisor {
    slots: Arc<Mutex<HashMap<String, Entry>>>,
    output: Arc<Mutex<()>>,
    store: Arc<Mutex<Option<murmo_store::protocol::Store>>>,
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>,
}

impl Supervisor {
    pub fn new() -> Self {
        Supervisor {
            slots: Arc::new(Mutex::new(HashMap::new())),
            output: Arc::new(Mutex::new(())),
            store: Arc::new(Mutex::new(None)),
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl Default for Supervisor {
    fn default() -> Self {
        Self::new()
    }
}

impl Supervisor {
    fn emit(&self, response: Value) {
        if let Some(id) = response.get("id").and_then(Value::as_u64) {
            if let Some(tx) = self.pending.lock().expect("pending").remove(&id) {
                let _ = tx.send(response);
                return;
            }
        }
        let _guard = self.output.lock().expect("output");
        reply_stdout(&response);
    }

    /// Stops every worker (`Entry::drop` ends its process).
    pub fn stop_all(&self) {
        self.slots.lock().expect("slots").clear();
    }

    pub fn wait_for(&self, id: u64) -> mpsc::Receiver<Value> {
        let (tx, rx) = mpsc::channel();
        self.pending.lock().expect("pending").insert(id, tx);
        rx
    }

    pub fn take_pending(&self, id: u64) -> Option<mpsc::Sender<Value>> {
        self.pending.lock().expect("pending").remove(&id)
    }

    pub fn dispatch(&self, q: Value) -> Option<Value> {
        let id = q.get("id").cloned().unwrap_or(Value::Null);
        let op = q.get("op").and_then(Value::as_str).unwrap_or("call");
        if op == "shutdown" {
            return Some(json!({"id": id, "status": "ok"}));
        }
        if op == "hello" {
            let mut response = if crate::protocol::hello_matches(&q) {
                crate::protocol::hello_ok()
            } else {
                crate::protocol::protocol_mismatch(&q)
            };
            response["id"] = id;
            return Some(response);
        }
        if is_store_op(op) {
            let mut response = store_handle(&self.store, &q);
            response["id"] = id;
            return Some(response);
        }
        if is_names_op(op) {
            let mut response = names_handle(&q);
            response["id"] = id;
            return Some(response);
        }
        if is_config_op(op) {
            let mut response = config_handle(&q);
            response["id"] = id;
            return Some(response);
        }
        if op == "call" || op == "fault" || q.get("op").is_none() {
            let name = q
                .get("plugin")
                .and_then(Value::as_str)
                .unwrap_or("default")
                .to_string();
            let tx = self
                .slots
                .lock()
                .expect("slots")
                .get(&name)
                .and_then(|e| e.tx.clone());
            if let Some(tx) = tx {
                let _ = tx.send(q);
                return None;
            }
            return Some(json!({
                "id": id,
                "status": "error",
                "kind": "transport",
                "error": "plugin not loaded",
            }));
        }

        let name = q
            .get("plugin")
            .and_then(Value::as_str)
            .unwrap_or("default")
            .to_string();
        let t = Instant::now();
        let mut response = match op {
            "ping" => json!({"status": "ok", "pong": true}),
            "load" => self.load(&name, q),
            "join" => self.join(&name, &q),
            "remove" => {
                self.slots.lock().expect("slots").remove(&name);
                json!({"status": "ok"})
            }
            "cancel" => self.cancel(&name, &q),
            "stats" => self.stats(),
            _ => json!({
                "status": "error",
                "kind": "transport",
                "error": format!("unknown op {op}"),
            }),
        };
        response["id"] = id;
        response["plugin"] = json!(name);
        response["totalMs"] = json!(t.elapsed().as_secs_f64() * 1000.0);
        Some(response)
    }

    fn load(&self, name: &str, q: Value) -> Value {
        match Worker::spawn(&q) {
            Ok(w) => {
                let pid = w.pid();
                let metadata = w.metadata.clone();
                let members = w.members.clone();
                let slot = Slot {
                    config: q,
                    worker: Some(w),
                    generation: 1,
                    restarts: 0,
                };
                let slot = Arc::new(Mutex::new(slot));
                let data = slot.clone();
                let (tx, rx) = mpsc::channel::<Value>();
                let supervisor = self.clone_handle();
                let tag = name.to_string();
                let active = Arc::new(AtomicU64::new(0));
                let current_pid = Arc::new(AtomicU32::new(pid));
                let active_run = active.clone();
                let pid_run = current_pid.clone();
                let control = Arc::new(Mutex::new(0u64));
                let control_run = control.clone();
                let runner = std::thread::spawn(move || {
                    for request in rx {
                        {
                            let _control = control_run.lock().expect("control");
                            active_run.store(
                                request
                                    .get("callToken")
                                    .and_then(Value::as_u64)
                                    .unwrap_or(0),
                                Ordering::SeqCst,
                            );
                        }
                        let mut state = data.lock().expect("slot");
                        let mut response = state.call(&request);
                        {
                            let cancelled_token = control_run.lock().expect("control");
                            let token = request
                                .get("callToken")
                                .and_then(Value::as_u64)
                                .unwrap_or(0);
                            if *cancelled_token != 0 && *cancelled_token == token {
                                if response.get("restarted") != Some(&json!(true)) {
                                    state.worker.take();
                                    state.generation += 1;
                                    state.restarts += 1;
                                    match Worker::spawn(&state.config) {
                                        Ok(w) => {
                                            state.worker = Some(w);
                                            response["restarted"] = json!(true);
                                            response["stateReset"] = json!(true);
                                        }
                                        Err(e) => response["restartError"] = json!(e),
                                    }
                                }
                                response["status"] = json!("error");
                                response["kind"] = json!("cancelled");
                                response["error"] = json!("cancelled");
                                response["generation"] = json!(state.generation);
                                response["restarts"] = json!(state.restarts);
                            }
                            active_run.store(0, Ordering::SeqCst);
                            pid_run.store(
                                state.worker.as_ref().map(|w| w.pid()).unwrap_or(0),
                                Ordering::SeqCst,
                            );
                        }
                        drop(state);
                        response["id"] = request.get("id").cloned().unwrap_or(Value::Null);
                        response["plugin"] = json!(tag.clone());
                        supervisor.emit(response);
                    }
                });
                self.slots.lock().expect("slots").insert(
                    name.to_string(),
                    Entry {
                        control,
                        active,
                        pid: current_pid,
                        slot,
                        tx: Some(tx),
                        runner: Some(runner),
                    },
                );
                json!({"status": "ok", "pid": pid, "metadata": metadata, "members": members})
            }
            Err(e) => error_reply(FaultKind::Plugin, &e),
        }
    }

    fn join(&self, name: &str, q: &Value) -> Value {
        let slot = self
            .slots
            .lock()
            .expect("slots")
            .get(name)
            .map(|e| e.slot.clone());
        match slot {
            Some(s) => {
                let mut state = s.lock().expect("slot");
                let reply = match state.worker.as_mut() {
                    Some(worker) => worker.request(q, INIT_WAIT_MS),
                    None => return error_reply(FaultKind::Transport, "plugin worker is down"),
                };
                match reply {
                    Ok(r) => {
                        let meta = r.get("metadata").cloned();
                        let member_id = q
                            .get("member")
                            .and_then(|m| m.get("id"))
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        if let (Some(meta), Some(id)) = (meta, member_id) {
                            if let Some(obj) = state.config.as_object_mut() {
                                let members = obj.entry("members").or_insert_with(|| json!([]));
                                if let Some(arr) = members.as_array_mut() {
                                    arr.push(q.get("member").cloned().unwrap_or(Value::Null));
                                }
                            }
                            if let Some(worker) = state.worker.as_mut() {
                                if let Some(map) = worker.members.as_object_mut() {
                                    map.insert(id, meta);
                                }
                            }
                        }
                        r
                    }
                    Err(e) => error_reply(FaultKind::Transport, &e),
                }
            }
            None => error_reply(FaultKind::Transport, "plugin not loaded"),
        }
    }

    fn cancel(&self, name: &str, q: &Value) -> Value {
        let map = self.slots.lock().expect("slots");
        let mut killed = false;
        if let Some(entry) = map.get(name) {
            let mut cancelled_token = entry.control.lock().expect("control");
            let token = q.get("callToken").and_then(Value::as_u64).unwrap_or(0);
            if token != 0 && entry.active.load(Ordering::SeqCst) == token {
                let pid = entry.pid.load(Ordering::SeqCst);
                if pid != 0 {
                    // SAFETY: pid is this supervisor's worker.
                    killed = unsafe { libc::kill(pid as i32, libc::SIGKILL) } == 0;
                    if killed {
                        *cancelled_token = token;
                    }
                }
            }
        }
        json!({"status": "ok", "cancelled": killed})
    }

    fn stats(&self) -> Value {
        let map = self.slots.lock().expect("slots");
        let plugins: Vec<Value> = map
            .iter()
            .map(|(id, s)| {
                let slot = s.slot.lock().expect("slot");
                let mut members = Vec::new();
                if let Some(w) = slot.worker.as_ref() {
                    if let Some(obj) = w.members.as_object() {
                        for (mid, meta) in obj {
                            members.push(json!({
                                "id": mid,
                                "hooks": meta.get("hooks"),
                                "generation": slot.generation,
                                "restarts": slot.restarts,
                            }));
                        }
                    }
                }
                json!({
                    "plugin": id,
                    "pid": slot.worker.as_ref().map(|w| w.pid()),
                    "generation": slot.generation,
                    "restarts": slot.restarts,
                    "members": members,
                })
            })
            .collect();
        json!({
            "status": "ok",
            "plugins": plugins,
            "services": {
                "storage": "brokered",
                "projectRead": "brokered",
                "submitCommitted": true,
                "projectFileChange": true,
            },
            "hooks": [
                "activate", "onChange", "onPause", "onKey", "onMenuSelect", "onAction",
                "onBeforeSubmit", "onSubmitCommitted", "onSubmitUnresolved",
                "onProjectFileChange", "deactivate"
            ],
        })
    }

    fn clone_handle(&self) -> SupervisorHandle {
        SupervisorHandle {
            output: self.output.clone(),
            pending: self.pending.clone(),
        }
    }
}

struct SupervisorHandle {
    output: Arc<Mutex<()>>,
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>,
}

impl SupervisorHandle {
    fn emit(&self, response: Value) {
        if let Some(id) = response.get("id").and_then(Value::as_u64) {
            if let Some(tx) = self.pending.lock().expect("pending").remove(&id) {
                let _ = tx.send(response);
                return;
            }
        }
        let _guard = self.output.lock().expect("output");
        reply_stdout(&response);
    }
}

/// Stdio supervisor loop. Returns after `shutdown`.
pub fn serve_stdio(supervisor: &Supervisor) {
    reply_stdout(&ready_message(std::process::id()));
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else {
            break;
        };
        if line_too_large(line.len()) {
            reply_stdout(&error_reply(FaultKind::OutputLimit, "line exceeds limit"));
            continue;
        }
        let Ok(q) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let op = q.get("op").and_then(Value::as_str).unwrap_or("call");
        if op == "shutdown" {
            break;
        }
        if let Some(response) = supervisor.dispatch(q) {
            supervisor.emit(response);
        }
    }
    supervisor.stop_all();
}

fn helper_method(method: &str) -> bool {
    method.starts_with("network.") || method == "project.list" || method.starts_with("git.")
}

fn coordinator_method(method: &str) -> bool {
    method.starts_with("storage.") || method == "project.read" || method == "project.readFile"
}

fn fulfill_helper(cfg: &Value, row: &Value) -> Option<Value> {
    let reqs = row.get("requests")?.as_array()?;
    let methods: Vec<&str> = reqs
        .iter()
        .map(|r| r.get("method").and_then(Value::as_str).unwrap_or(""))
        .collect();
    if methods.iter().any(|m| helper_method(m)) && methods.iter().any(|m| coordinator_method(m)) {
        return None;
    }
    if !methods.iter().any(|m| helper_method(m)) {
        return None;
    }
    let origins: Vec<String> = cfg
        .get("networkOrigins")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let root = cfg.get("projectRoot").and_then(Value::as_str).unwrap_or("");
    let replies: Vec<Value> = reqs
        .iter()
        .map(|req| {
            let id = req.get("id").cloned().unwrap_or(Value::Null);
            let method = req.get("method").and_then(Value::as_str).unwrap_or("");
            let args = req.get("args").cloned().unwrap_or(json!([]));
            let value = match method {
                "network.request" => {
                    let spec = args.get(0).cloned().unwrap_or(json!({}));
                    crate::network::handle(
                        &spec,
                        &origins,
                        origins.iter().any(|o| o.contains("127.0.0.1")),
                    )
                }
                "project.list" => {
                    let query = args.get(0).cloned().unwrap_or(json!({}));
                    crate::listing::handle(root, &query)
                }
                "git.query" => {
                    let spec = args.get(0).cloned().unwrap_or(json!({}));
                    crate::git::handle(root, &spec)
                }
                _ => json!({"status": "denied", "reason": "broker denied"}),
            };
            json!({"id": id, "value": value})
        })
        .collect();
    Some(json!(replies))
}

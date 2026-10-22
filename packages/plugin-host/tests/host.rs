//! Binary-level checks: handshake, load refusal, containment, output-limit,
//! first-party members, and no ambient file readers (E1, E5, E8).

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_murmo-plugin-host")
}

struct Host {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
    next_id: u64,
}

impl Host {
    fn spawn() -> Self {
        Self::spawn_with(&[])
    }

    fn spawn_with(env: &[(&str, &std::path::Path)]) -> Self {
        let mut child = Command::new(bin())
            .envs(env.iter().map(|(k, v)| (*k, v.as_os_str())))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn helper");
        let stdin = child.stdin.take().expect("stdin");
        let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));
        let mut line = String::new();
        stdout.read_line(&mut line).expect("ready");
        let ready: Value = serde_json::from_str(&line).expect("ready json");
        assert_eq!(ready["protocol"], 1, "handshake protocol");
        assert_eq!(ready["apiVersion"], "2.0.0");
        Host {
            child,
            stdin,
            stdout,
            next_id: 1,
        }
    }

    fn rpc(&mut self, mut q: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        q["id"] = json!(id);
        writeln!(self.stdin, "{q}").expect("write");
        self.stdin.flush().expect("flush");
        let mut line = String::new();
        self.stdout.read_line(&mut line).expect("reply");
        serde_json::from_str(&line).unwrap_or_else(|_| json!({"raw": line}))
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = writeln!(self.stdin, r#"{{"op":"shutdown"}}"#);
        let _ = self.child.wait();
    }
}

#[test]
fn hello_refuses_a_mismatched_binary() {
    let mut host = Host::spawn();
    let ok = host.rpc(json!({"op":"hello","protocol":1,"apiVersion":"2.0.0"}));
    assert_eq!(ok["status"], "ok");
    let bad = host.rpc(json!({"op":"hello","protocol":2,"apiVersion":"2.0.0"}));
    assert_eq!(bad["status"], "error");
    assert_eq!(bad["kind"], "transport");
}

#[test]
fn load_without_a_memory_cap_is_refused() {
    // Prototype fell back to 32 MiB (E8); a missing cap must not sneak through.
    let mut host = Host::spawn();
    let r = host.rpc(json!({
        "op": "load",
        "plugin": "p",
        "source": "export default () => ({name:'p',version:'1',permissions:[]})",
        "format": "esm",
    }));
    assert_eq!(r["status"], "error", "{r}");
    assert!(
        r["error"].as_str().unwrap_or("").contains("memoryMiB"),
        "{r}"
    );
}

#[test]
fn all_published_hooks_appear_in_the_descriptor() {
    // Lesson 73: the installed helper dropped routes the fake still had.
    let mut host = Host::spawn();
    let source = r#"
export default () => ({
  name: 'full',
  version: '1',
  permissions: ['draft:read','submit','submit:observe','fs:project-read'],
  activate() {},
  onChange() {},
  onKey() {},
  onMenuSelect() {},
  onAction() {},
  onBeforeSubmit() {},
  onSubmitCommitted() {},
  onSubmitUnresolved() {},
  onProjectFileChange() {},
  deactivate() {},
});
"#;
    let r = host.rpc(json!({
        "op": "load",
        "plugin": "full",
        "source": source,
        "format": "esm",
        "memoryMiB": 8,
        "sliceMs": 5,
    }));
    assert_eq!(r["status"], "ok", "{r}");
    let hooks = r["metadata"]["hooks"].as_array().expect("hooks");
    for name in [
        "activate",
        "onChange",
        "onKey",
        "onMenuSelect",
        "onAction",
        "onBeforeSubmit",
        "onSubmitCommitted",
        "onSubmitUnresolved",
        "onProjectFileChange",
        "deactivate",
    ] {
        assert!(
            hooks.iter().any(|h| h == name),
            "missing hook {name} in {hooks:?}"
        );
    }
}

#[test]
fn a_busy_loop_is_interrupted_as_cpu_within_about_10_ms() {
    // Vision: stuck plugin stopped within about 5 ms; r11b had one sample (E2).
    let mut host = Host::spawn();
    let source = r#"
export default () => ({
  name: 'looper',
  version: '1',
  permissions: [],
  onKey() { const end = Date.now() + 200; while (Date.now() < end) {} return []; },
});
"#;
    let load = host.rpc(json!({
        "op": "load",
        "plugin": "looper",
        "source": source,
        "format": "esm",
        "memoryMiB": 8,
        "sliceMs": 5,
    }));
    assert_eq!(load["status"], "ok", "{load}");
    let t = Instant::now();
    let r = host.rpc(json!({
        "op": "call",
        "plugin": "looper",
        "hook": "onKey",
        "input": "x",
        "context": {},
        "deadlineMs": 50,
        "sliceMs": 5,
        "callToken": 1,
    }));
    let elapsed = t.elapsed();
    assert_eq!(r["status"], "error", "{r}");
    assert_eq!(r["kind"], "cpu", "{r}");
    assert!(
        elapsed < Duration::from_millis(80),
        "looper took {elapsed:?}"
    );
}

#[test]
fn ten_thousand_effects_are_output_limit() {
    // L6: a 10,000-edit reply was processed by the host.
    let mut host = Host::spawn();
    let source = r#"
export default () => ({
  name: 'flood',
  version: '1',
  permissions: [],
  onChange() { const out = []; for (let i = 0; i < 10000; i++) out.push({type:'edit',edit:{from:0,to:0,insert:String(i),baseVersion:1}}); return out; },
});
"#;
    let load = host.rpc(json!({
        "op": "load",
        "plugin": "flood",
        "source": source,
        "format": "esm",
        "memoryMiB": 8,
        "sliceMs": 20,
    }));
    assert_eq!(load["status"], "ok", "{load}");
    let r = host.rpc(json!({
        "op": "call",
        "plugin": "flood",
        "hook": "onChange",
        "input": {},
        "context": {},
        "deadlineMs": 200,
        "sliceMs": 50,
        "callToken": 1,
    }));
    assert_eq!(r["status"], "error", "{r}");
    assert_eq!(r["kind"], "output-limit", "{r}");
}

#[test]
fn first_party_members_share_one_worker_and_keep_separate_descriptors() {
    let mut host = Host::spawn();
    let a = "export default () => ({name:'a',version:'1',permissions:[],onChange(){return [{type:'status',text:'a',baseVersion:1}];}})";
    let b = "export default () => ({name:'b',version:'1',permissions:[],onChange(){return [{type:'status',text:'b',baseVersion:1}];}})";
    let load = host.rpc(json!({
        "op": "load",
        "plugin": "first-party",
        "memoryMiB": 8,
        "sliceMs": 5,
        "members": [
            {"id": "a", "source": a, "settings": {}},
            {"id": "b", "source": b, "settings": {}},
        ],
    }));
    assert_eq!(load["status"], "ok", "{load}");
    assert_eq!(load["members"]["a"]["name"], "a");
    assert_eq!(load["members"]["b"]["name"], "b");
    let ra = host.rpc(json!({
        "op": "call",
        "plugin": "first-party",
        "member": "a",
        "hook": "onChange",
        "input": {},
        "context": {},
        "deadlineMs": 50,
        "callToken": 1,
    }));
    assert_eq!(ra["status"], "ok", "{ra}");
    assert_eq!(ra["value"][0]["text"], "a");
    let rb = host.rpc(json!({
        "op": "call",
        "plugin": "first-party",
        "member": "b",
        "hook": "onChange",
        "input": {},
        "context": {},
        "deadlineMs": 50,
        "callToken": 2,
    }));
    assert_eq!(rb["status"], "ok", "{rb}");
    assert_eq!(rb["value"][0]["text"], "b");
}

#[test]
fn storage_and_project_round_trip_through_the_broker() {
    // Routes the installed helper dropped (E5): storage and project.read.
    let mut host = Host::spawn();
    let source = r#"
export default () => ({
  name: 'svc',
  version: '1',
  permissions: ['fs:project-read'],
  async onChange(_c, ctx) {
    const got = await ctx.storage.get('k');
    const set = await ctx.storage.set('k', 1);
    const read = await ctx.project.read('ok.txt');
    const file = await ctx.project.readFile('ok.txt');
    return [{type:'status', text: JSON.stringify({got,set,read,file}), baseVersion:1}];
  },
});
"#;
    let load = host.rpc(json!({
        "op": "load",
        "plugin": "svc",
        "source": source,
        "format": "esm",
        "memoryMiB": 8,
        "sliceMs": 20,
    }));
    assert_eq!(load["status"], "ok", "{load}");
    let mut r = host.rpc(json!({
        "op": "call",
        "plugin": "svc",
        "hook": "onChange",
        "input": {},
        "context": {},
        "deadlineMs": 200,
        "sliceMs": 50,
        "callToken": 1,
    }));
    let mut saw_storage = false;
    let mut saw_project = false;
    for _ in 0..16 {
        if r["status"] == "ok" {
            break;
        }
        assert_eq!(r["status"], "broker", "{r}");
        let requests = r["requests"].as_array().cloned().unwrap_or_default();
        let replies: Vec<Value> = requests
            .iter()
            .map(|c| {
                let method = c["method"].as_str().unwrap_or("");
                if method.starts_with("storage.") {
                    saw_storage = true;
                }
                if method.starts_with("project.") {
                    saw_project = true;
                }
                let value = match method {
                    "storage.get" => json!({"status":"ok"}),
                    "storage.set" => json!({"status":"ok"}),
                    "project.read" => json!({"status":"ok","text":"hi"}),
                    "project.readFile" => json!("hi"),
                    _ => json!({"status":"denied"}),
                };
                json!({"id": c["id"], "value": value})
            })
            .collect();
        r = host.rpc(json!({
            "op": "call",
            "plugin": "svc",
            "hook": "onChange",
            "resume": true,
            "replies": replies,
            "deadlineMs": 200,
            "sliceMs": 50,
            "callToken": 1,
        }));
    }
    assert_eq!(r["status"], "ok", "{r}");
    assert!(saw_storage, "storage broker never used");
    assert!(saw_project, "project broker never used");
}

#[test]
fn stats_lists_the_hooks_and_services_actually_carried() {
    let mut host = Host::spawn();
    let stats = host.rpc(json!({"op":"stats"}));
    assert_eq!(stats["status"], "ok", "{stats}");
    assert_eq!(stats["services"]["storage"], "brokered");
    assert_eq!(stats["services"]["projectRead"], "brokered");
    assert_eq!(stats["services"]["submitCommitted"], true);
    assert_eq!(stats["services"]["projectFileChange"], true);
}

#[test]
fn a_256_kib_stack_allows_hundreds_of_recursive_frames() {
    // api.md says 256 KiB; the r11b helper used 512. Hundreds of frames is
    // more than any plugin hook needs, so we keep the published figure.
    let mut host = Host::spawn();
    let source = r#"
export default () => ({
  name: 'deep',
  version: '1',
  permissions: [],
  onChange() {
    let n = 0;
    const go = () => { n++; go(); };
    try { go(); } catch (e) {}
    return [{ type: 'status', text: String(n), baseVersion: 1 }];
  },
});
"#;
    let load = host.rpc(json!({
        "op": "load",
        "plugin": "deep",
        "source": source,
        "format": "esm",
        "memoryMiB": 8,
        "sliceMs": 50,
    }));
    assert_eq!(load["status"], "ok", "{load}");
    let r = host.rpc(json!({
        "op": "call",
        "plugin": "deep",
        "hook": "onChange",
        "input": {},
        "context": {},
        "deadlineMs": 200,
        "sliceMs": 50,
        "callToken": 1,
    }));
    assert_eq!(r["status"], "ok", "{r}");
    let n: u64 = r["value"][0]["text"]
        .as_str()
        .unwrap_or("0")
        .parse()
        .unwrap_or(0);
    assert!(n > 200, "only {n} frames on a 256 KiB stack");
}

#[test]
fn malformed_lines_do_not_kill_the_supervisor() {
    // Protocol fuzz: a bad line must not take down the session (task 2).
    let mut host = Host::spawn();
    writeln!(host.stdin, "not-json").expect("write");
    host.stdin.flush().expect("flush");
    let ping = host.rpc(json!({"op":"ping"}));
    assert_eq!(ping["status"], "ok", "{ping}");
}

#[test]
fn names_search_returns_candidates_without_source_text() {
    let recs = vec![murmo_indexer::NameRecord::new(
        "OutboxWorker",
        "class",
        "src/outbox/worker.rs",
        12,
        9,
        "",
    )];
    let bytes = murmo_indexer::build_packed(&recs);
    assert!(!bytes.windows(3).any(|w| w == b"fn "));
    let dir = std::env::temp_dir().join(format!("murmo-names-host-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("names.bin");
    std::fs::write(&path, &bytes).unwrap();
    let mut host = Host::spawn();
    let load = host.rpc(json!({"op":"names.load","path": path.to_str().unwrap()}));
    assert_eq!(load["status"], "ok", "{load}");
    let s = host.rpc(json!({
        "op": "names.search",
        "raw": "OutboxWorkr",
        "key": "outbox workr",
        "limit": 96,
        "budgetUs": 300
    }));
    assert_eq!(s["status"], "ok", "{s}");
    let rows = s["rows"].as_array().cloned().unwrap_or_default();
    assert!(rows.iter().any(|r| r["name"] == "OutboxWorker"), "{rows:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A throwaway home and store for `config.load`, removed on drop.
struct ConfigHome(std::path::PathBuf);

impl ConfigHome {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("murmo-config-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("home/.config/murmo")).unwrap();
        std::fs::create_dir_all(dir.join("repo/.git")).unwrap();
        ConfigHome(std::fs::canonicalize(&dir).unwrap())
    }

    fn host(&self) -> Host {
        let home = self.0.join("home");
        Host::spawn_with(&[
            ("HOME", &home),
            ("XDG_CONFIG_HOME", &home.join(".config")),
            ("XDG_DATA_HOME", &home.join("data")),
            ("XDG_STATE_HOME", &home.join("state")),
            ("XDG_CACHE_HOME", &home.join("cache")),
        ])
    }
}

impl Drop for ConfigHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn config_load_merges_the_personal_file_and_never_an_unreviewed_project() {
    // Catches the Claude bug (fixtures/hosts/project-shortcuts.json): the helper
    // must load the personal file from the session's own XDG home, and a
    // project file no one approved must add no shortcut, only the review notice.
    let t = ConfigHome::new("unreviewed");
    std::fs::write(
        t.0.join("home/.config/murmo/murmo.toml"),
        "version = 1\n[replace]\n\";me\" = 'personal'\n",
    )
    .unwrap();
    std::fs::write(
        t.0.join("repo/.murmo.toml"),
        "version = 1\n[replace]\n\";hp\" = 'project'\n",
    )
    .unwrap();
    let mut host = t.host();
    let r = host.rpc(json!({"op": "config.load", "cwd": t.0.join("repo").to_str().unwrap()}));
    assert_eq!(r["status"], "ok", "{r}");
    let session = &r["session"];
    assert_eq!(session["trust"], "review", "{session}");
    let shortcuts: Vec<_> = session["effective"]["replacements"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["shortcut"].as_str().unwrap(),
                s["origin"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(shortcuts, [(";me", "user")]);
    let codes: Vec<_> = session["effective"]["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["code"].as_str().unwrap())
        .collect();
    assert_eq!(codes, ["untrusted"]);
    assert!(session["project"]["fingerprint"].is_string(), "{session}");
}

#[test]
fn config_load_refuses_a_relative_cwd() {
    // A relative cwd would resolve against the helper's own working directory,
    // a different repository than the session's.
    let t = ConfigHome::new("relative");
    let mut host = t.host();
    let r = host.rpc(json!({"op": "config.load", "cwd": "repo"}));
    assert_eq!(r["status"], "error", "{r}");
    assert_eq!(r["kind"], "transport");
}

/// One `POST /rpc` over the helper's Unix socket, as Claude's `$.http.fetch({socketPath})` sends it.
fn post(socket: &std::path::Path, body: &Value) -> Value {
    use std::io::Read;
    let mut stream = std::os::unix::net::UnixStream::connect(socket).expect("connect");
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let body = body.to_string();
    write!(
        stream,
        "POST /rpc HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    let mut bytes = Vec::new();
    let mut block = [0u8; 4096];
    loop {
        let n = stream.read(&mut block).expect("reply");
        assert!(n > 0, "helper closed the connection");
        bytes.extend_from_slice(&block[..n]);
        let text = String::from_utf8_lossy(&bytes);
        if let Some((head, rest)) = text.split_once("\r\n\r\n") {
            let length: usize = head
                .lines()
                .find_map(|l| l.strip_prefix("Content-Length: "))
                .and_then(|v| v.trim().parse().ok())
                .expect("content-length");
            if rest.len() >= length {
                return serde_json::from_str(&rest[..length]).expect("json body");
            }
        }
    }
}

fn wait_gone(pid: i32, within: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < within {
        // SAFETY: signal 0 only checks that the process exists.
        if unsafe { libc::kill(pid, 0) } != 0 {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

#[test]
fn http_mode_outlives_a_closed_stdin_and_stops_on_shutdown() {
    // Claude 2.1.306's `$.process.spawn` gives the helper no stdin: the helper
    // read EOF right after ready and exited before Claude's first fetch.
    let t = ConfigHome::new("http");
    let socket = t.0.join("h.sock");
    let home = t.0.join("home");
    let mut child = Command::new(bin())
        .args(["--http", "--socket", socket.to_str().unwrap()])
        .env("HOME", &home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("XDG_DATA_HOME", home.join("data"))
        .env("XDG_STATE_HOME", home.join("state"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn helper");
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .expect("ready");
    let ready: Value = serde_json::from_str(&line).expect("ready json");
    assert_eq!(ready["socket"], socket.to_str().unwrap());
    // Other local users can neither connect to the socket nor reach a port.
    assert!(ready.get("port").is_none(), "{ready}");
    let mode =
        std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&socket).unwrap().permissions());
    assert_eq!(mode & 0o777, 0o600);
    std::thread::sleep(Duration::from_millis(500));
    assert!(
        child.try_wait().unwrap().is_none(),
        "helper exited on stdin EOF"
    );
    let r = post(
        &socket,
        &json!({"op": "config.load", "cwd": t.0.join("repo").to_str().unwrap()}),
    );
    assert_eq!(r["status"], "ok", "{r}");
    assert_eq!(post(&socket, &json!({"op": "shutdown"}))["status"], "ok");
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(
            start.elapsed() < Duration::from_secs(3),
            "helper ignored shutdown"
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(status.success(), "{status}");
    assert!(!socket.exists(), "socket left behind");
}

#[test]
fn http_mode_exits_when_its_parent_does() {
    // A crashed or killed plugin runtime must not leave a helper (and its
    // socket) behind for the rest of the login session.
    let t = ConfigHome::new("orphan");
    let socket = t.0.join("o.sock");
    let out = Command::new("/bin/sh")
        .args([
            "-c",
            r#""$0" --http --socket "$1" >/dev/null 2>&1 </dev/null & while [ ! -S "$1" ]; do sleep 0.02; done; echo $!"#,
            bin(),
            socket.to_str().unwrap(),
        ])
        .output()
        .expect("spawn parent");
    let pid: i32 = String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .expect("helper pid");
    assert!(
        wait_gone(pid, Duration::from_secs(3)),
        "orphaned helper kept running"
    );
    let start = Instant::now();
    while socket.exists() && start.elapsed() < Duration::from_secs(1) {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!socket.exists(), "orphaned helper left its socket");
}

#[test]
fn http_mode_removes_its_socket_on_sigterm() {
    // Claude 2.1.306 SIGTERMs `$.process.spawn` children on exit, before
    // `session.end` can send `shutdown`: each session left a socket in $TMPDIR.
    let t = ConfigHome::new("sigterm");
    let socket = t.0.join("t.sock");
    let mut child = Command::new(bin())
        .args(["--http", "--socket", socket.to_str().unwrap()])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn helper");
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .expect("ready");
    assert!(socket.exists());
    // SAFETY: signals the helper this test started.
    assert_eq!(unsafe { libc::kill(child.id() as i32, libc::SIGTERM) }, 0);
    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(128 + libc::SIGTERM), "{status}");
    assert!(!socket.exists(), "SIGTERM left the socket behind");
}

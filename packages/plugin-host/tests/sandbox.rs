//! Four r11 OS probes against a sandboxed helper (C sandbox, E27).
//! Nested `sandbox-exec` is refused inside the offline harness (`sandbox_apply:
//! Operation not permitted`). Live file/spawn/tcp then skip with that reason
//! and the worker policy is still checked. Inherited env is proven with
//! `env_clear`, which production workers always apply.

use murmo_plugin_host::sandbox::{
    policy_denies_network, run_sandboxed_probes, spawn_worker, start_failure, write_probe_home,
    SANDBOX_REFUSED_EXIT, SANDBOX_UNAVAILABLE,
};
use serde_json::Value;
use std::io::{BufRead, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Command, Stdio};

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_murmo-plugin-host")
}

fn parse_probe(stdout: &str) -> Value {
    let line = stdout
        .lines()
        .rev()
        .find(|l| l.starts_with('{'))
        .unwrap_or("{}");
    serde_json::from_str(line).unwrap_or_else(|_| serde_json::json!({}))
}

#[test]
fn sandboxed_worker_blocks_tcp_file_spawn_and_env() {
    let dir = std::env::temp_dir().join(format!("murmo-probe-{}", std::process::id()));
    let canary = write_probe_home(&dir).expect("canary");
    let (port, have_loopback) = match TcpListener::bind("127.0.0.1:0") {
        Ok(listener) => {
            let port = listener.local_addr().unwrap().port();
            thread_accept(listener);
            (port, true)
        }
        Err(_) => (9, false),
    };

    let baseline = Command::new(bin())
        .arg("--sandbox-probe")
        .arg("--canary")
        .arg(&canary)
        .arg("--port")
        .arg(port.to_string())
        .env("FAKE_SECRET", "SYNTHETIC_SECRET")
        .output()
        .expect("unsandboxed probe");
    let base = parse_probe(&String::from_utf8_lossy(&baseline.stdout));
    assert_eq!(base["file"], true, "baseline file {base}");
    assert_eq!(base["spawn"], true, "baseline spawn {base}");
    assert_eq!(base["env"], true, "baseline env {base}");

    let scrubbed = Command::new(bin())
        .arg("--sandbox-probe")
        .arg("--canary")
        .arg(&canary)
        .arg("--port")
        .arg(port.to_string())
        .env_clear()
        .output()
        .expect("env-cleared probe");
    let cleared = parse_probe(&String::from_utf8_lossy(&scrubbed.stdout));
    assert_eq!(
        cleared["env"], false,
        "production workers env_clear: {cleared}"
    );

    match run_sandboxed_probes(Path::new(bin()), canary.to_str().unwrap(), port) {
        Ok(sandboxed) => {
            assert_eq!(sandboxed["file"], false, "canary read {sandboxed}");
            assert_eq!(sandboxed["spawn"], false, "spawn {sandboxed}");
            assert_eq!(sandboxed["env"], false, "inherited env {sandboxed}");
            if have_loopback && base["tcp"] == true {
                assert_eq!(sandboxed["tcp"], false, "tcp {sandboxed}");
            } else {
                assert!(
                    policy_denies_network(),
                    "live TCP skipped: outer offline sandbox denies loopback bind"
                );
            }
        }
        Err(e) if e.contains("Operation not permitted") || e.contains("sandbox_apply") => {
            assert!(
                policy_denies_network(),
                "live nested sandbox-exec skipped ({e}); worker policy must still deny network"
            );
        }
        Err(e) => panic!("sandboxed probe: {e}"),
    }

    match spawn_worker(Path::new(bin()), true) {
        Ok(mut child) => {
            let _ = child.kill();
            let _ = child.wait();
        }
        Err(e) => assert!(
            e.contains("sandbox")
                || e.contains("landlock")
                || e.contains("sandbox-exec")
                || e.contains("Operation not permitted")
                || e.contains("not available"),
            "third-party load must fail closed when the sandbox cannot apply: {e}"
        ),
    }

    let mut helper = Command::new(bin())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("helper");
    let mut input = helper.stdin.take().unwrap();
    let mut output = std::io::BufReader::new(helper.stdout.take().unwrap());
    let mut ready = String::new();
    output.read_line(&mut ready).ok();
    writeln!(
        input,
        r#"{{"op":"load","id":1,"plugin":"p","source":"export default () => ({{name:'p',version:'1',permissions:[]}})","format":"esm","memoryMiB":8,"sandbox":true}}"#
    )
    .ok();
    let mut reply = String::new();
    output.read_line(&mut reply).ok();
    // A refused sandbox used to come back as "guest worker exited", which reads
    // like a plugin crash; the user and `murmo plugin test` must see the cause.
    let row: Value = serde_json::from_str(&reply).unwrap_or_default();
    assert!(
        row["status"] == "ok" || row["error"] == SANDBOX_UNAVAILABLE,
        "third-party load is ok or names the refused sandbox: {reply:?}"
    );
    let _ = writeln!(input, r#"{{"op":"shutdown"}}"#);
    let _ = helper.wait();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn only_a_refused_sandbox_is_reported_as_one() {
    // A worker that dies on its own must still read as a crash, never as a
    // sandbox the system refused, and a refusal must never read as a crash.
    let exit = |code: i32| {
        Command::new("/bin/sh")
            .arg("-c")
            .arg(format!("exit {code}"))
            .spawn()
            .expect("sh")
    };
    assert_eq!(
        start_failure(&mut exit(SANDBOX_REFUSED_EXIT), true),
        SANDBOX_UNAVAILABLE
    );
    assert_eq!(start_failure(&mut exit(1), true), "guest worker exited");
    assert_eq!(
        start_failure(&mut exit(SANDBOX_REFUSED_EXIT), false),
        "guest worker exited"
    );
}

fn thread_accept(listener: TcpListener) {
    std::thread::spawn(move || {
        let _ = listener.accept();
    });
}

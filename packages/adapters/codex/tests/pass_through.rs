//! `murmo-codex <args>` equals stock `codex <args>` for non-interactive
//! commands: stdout, stderr, exit code, and no PTY (lesson 40).

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::Command;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_murmo-codex")
}

fn fake_codex(dir: &std::path::Path) -> PathBuf {
    let path = dir.join("codex");
    fs::write(
        &path,
        r#"#!/bin/sh
echo "STDOUT:$*"
echo "STDERR:tty=$(test -t 0 && echo yes || echo no)" >&2
exit 23
"#,
    )
    .unwrap();
    let mut p = fs::metadata(&path).unwrap().permissions();
    p.set_mode(0o755);
    fs::set_permissions(&path, p).unwrap();
    path
}

fn run(dir: &std::path::Path, args: &[&str]) -> std::process::Output {
    let path = format!(
        "{}:{}",
        dir.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    Command::new(bin())
        .args(args)
        .env("PATH", path)
        .env("MURMO_CODEX_BIN", dir.join("codex"))
        .env_remove("MURMO_CODEX_WRAP")
        .output()
        .expect("spawn murmo-codex")
}

#[test]
fn non_interactive_commands_match_stock_bytes_and_exit() {
    let dir = std::env::temp_dir().join(format!("murmo-codex-pt-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    fake_codex(&dir);
    for args in [
        &["exec", "--help"] as &[&str],
        &["app-server", "--help"],
        &["mcp", "--help"],
        &["update", "--help"],
        &["--version"],
    ] {
        let out = run(&dir, args);
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(23), "{args:?} status");
        assert!(
            stdout.contains(&format!("STDOUT:{}", args.join(" "))),
            "{args:?} stdout={stdout}"
        );
        assert!(
            stderr.contains("tty=no"),
            "{args:?} must not create a PTY, stderr={stderr}"
        );
    }
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn recursion_guard_refuses_to_wrap_self() {
    let out = Command::new(bin())
        .arg("--no-alt-screen")
        .env("MURMO_CODEX_WRAP", "1")
        .output()
        .unwrap();
    assert_ne!(out.status.code(), Some(0));
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        err.contains("refused to wrap itself") || err.contains("not found"),
        "{err}"
    );
}

//! Fake-server LSP protocol: hang is killed, crash leaves other sources (E2).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use murmo_indexer::lsp::run_servers;

fn temp() -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "murmo-lsp-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("src")).unwrap();
    dir
}

fn git(root: &Path) {
    let st = Command::new("git")
        .args(["init", "-q"])
        .current_dir(root)
        .status()
        .unwrap();
    assert!(st.success());
    Command::new("git")
        .args(["config", "user.email", "murmo@test"])
        .current_dir(root)
        .status()
        .unwrap();
    Command::new("git")
        .args(["config", "user.name", "murmo"])
        .current_dir(root)
        .status()
        .unwrap();
    Command::new("git")
        .args(["config", "commit.gpgsign", "false"])
        .current_dir(root)
        .status()
        .unwrap();
    fs::write(root.join("src/lib.rs"), "pub fn alpha() {}\n").unwrap();
    fs::write(
        root.join("src/lsp_only.ts"),
        "export class LspOnlyType {}\n",
    )
    .unwrap();
    Command::new("git")
        .args(["add", "-A"])
        .current_dir(root)
        .status()
        .unwrap();
    Command::new("git")
        .args([
            "-c",
            "user.email=murmo@test",
            "-c",
            "user.name=murmo",
            "commit",
            "-qm",
            "init",
        ])
        .current_dir(root)
        .status()
        .unwrap();
}

fn fake_bin(mode: &str) -> PathBuf {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fake_lsp.mjs");
    let dir = std::env::temp_dir().join(format!("murmo-fake-lsp-{}-{mode}", std::process::id()));
    let _ = fs::create_dir_all(&dir);
    let dest = dir.join("murmo-fake-lsp");
    let flag = match mode {
        "hang" => "--hang",
        "crash" => "--crash",
        "outside" => "--outside",
        _ => "",
    };
    let body = format!("#!/bin/sh\nexec node {} {flag} \"$@\"\n", script.display());
    fs::write(&dest, body).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut p = fs::metadata(&dest).unwrap().permissions();
        p.set_mode(0o755);
        fs::set_permissions(&dest, p).unwrap();
    }
    dest
}

fn with_path(extra: &Path) {
    let mut path = extra.display().to_string();
    if let Ok(old) = std::env::var("PATH") {
        path = format!("{path}:{old}");
    }
    // SAFETY: tests run single-threaded for env; we restore after each case.
    unsafe { std::env::set_var("PATH", path) };
}

#[test]
fn fake_server_adds_definition_and_drops_outside_root() {
    let root = temp();
    git(&root);
    let bin_dir = fake_bin("ok").parent().unwrap().to_path_buf();
    with_path(&bin_dir);
    unsafe { std::env::set_var("FAKE_LSP_ROOT", root.to_string_lossy().as_ref()) };
    let tagged = Default::default();
    let results = run_servers(&root, &["murmo-fake-lsp".into()], 5_000, &tagged);
    assert_eq!(results.len(), 1);
    let r = &results[0];
    assert!(r.error.is_none(), "{:?}", r.error);
    assert!(
        r.records.iter().any(|n| n.name == "LspOnlyType"),
        "{:?}",
        r.records
    );
    assert!(r
        .records
        .iter()
        .all(|n| n.file != "/tmp/not-in-repo/out.ts"));
    assert!(r
        .records
        .iter()
        .all(|n| !n.name.contains("ignoredVariable")));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn hanging_server_is_killed_within_timeout() {
    let root = temp();
    git(&root);
    let bin_dir = fake_bin("hang").parent().unwrap().to_path_buf();
    with_path(&bin_dir);
    unsafe { std::env::set_var("FAKE_LSP_ROOT", root.to_string_lossy().as_ref()) };
    let start = Instant::now();
    let results = run_servers(
        &root,
        &["murmo-fake-lsp".into()],
        1_200,
        &Default::default(),
    );
    let elapsed = start.elapsed();
    assert!(
        elapsed.as_millis() < 8_000,
        "hang was not killed, took {elapsed:?}"
    );
    assert!(results[0].error.is_some(), "hang must record an error");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn crashed_server_records_error_and_other_sources_remain() {
    let root = temp();
    git(&root);
    let bin_dir = fake_bin("crash").parent().unwrap().to_path_buf();
    with_path(&bin_dir);
    unsafe { std::env::set_var("FAKE_LSP_ROOT", root.to_string_lossy().as_ref()) };
    let results = run_servers(
        &root,
        &["murmo-fake-lsp".into()],
        5_000,
        &Default::default(),
    );
    assert!(results[0].error.is_some());
    assert!(results[0].records.is_empty());
    let (state, recs, _) =
        murmo_indexer::incremental::update(&root, &["src/lib.rs".into()], &Default::default());
    assert!(recs.iter().any(|r| r.name == "alpha"), "tags still built");
    assert!(!state.is_empty());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn outside_uri_is_dropped() {
    let root = temp();
    git(&root);
    let bin_dir = fake_bin("outside").parent().unwrap().to_path_buf();
    with_path(&bin_dir);
    unsafe { std::env::set_var("FAKE_LSP_ROOT", root.to_string_lossy().as_ref()) };
    let results = run_servers(
        &root,
        &["murmo-fake-lsp".into()],
        5_000,
        &Default::default(),
    );
    assert!(results[0].records.is_empty(), "{:?}", results[0].records);
    let _ = fs::remove_dir_all(&root);
}

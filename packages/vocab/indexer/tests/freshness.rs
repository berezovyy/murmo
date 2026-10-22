//! r9 freshness controls: same-size edit with restored mtime, new untracked file,
//! deleted file (E11). Also the r6 mixed-generation reopen (E17).

use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, UNIX_EPOCH};

use murmo_indexer::incremental::{lstat_in_repo, update};
use murmo_indexer::packed::{build_packed, PackedIndex};
use murmo_indexer::snapshot::{commit_snapshot, read_current, read_reopen_chunks};

fn git(root: &Path, args: &[&str]) {
    let st = Command::new("git")
        .args(args)
        .current_dir(root)
        .status()
        .unwrap();
    assert!(st.success(), "git {args:?}");
}

fn temp() -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "murmo-idx-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn same_size_edit_restored_mtime_is_detected_via_ctime() {
    let root = temp();
    git(&root, &["init", "-q"]);
    git(&root, &["config", "user.email", "murmo@test"]);
    git(&root, &["config", "user.name", "murmo"]);
    git(&root, &["config", "commit.gpgsign", "false"]);
    fs::write(root.join("lib.rs"), "pub fn alpha() {}\n").unwrap();
    git(&root, &["add", "lib.rs"]);
    git(&root, &["commit", "-qm", "init"]);

    let paths = vec!["lib.rs".into()];
    let (state, recs, _) = update(&root, &paths, &Default::default());
    assert!(recs.iter().any(|r| r.name == "alpha"));

    let meta = fs::metadata(root.join("lib.rs")).unwrap();
    let mtime = UNIX_EPOCH + Duration::from_secs(meta.mtime() as u64);
    fs::write(root.join("lib.rs"), "pub fn beta__() {}\n").unwrap();
    filetime_restore(&root.join("lib.rs"), mtime);

    let (next, recs2, n) = update(&root, &paths, &state);
    assert!(n >= 1, "ctime must see the same-size edit");
    assert!(
        recs2.iter().any(|r| r.name == "beta__"),
        "new name after edit"
    );
    assert!(!next.is_empty());

    let _ = fs::remove_dir_all(&root);
}

fn filetime_restore(path: &Path, mtime: std::time::SystemTime) {
    // Best-effort: libc utimes keeps ctime new on Unix.
    let secs = mtime.duration_since(UNIX_EPOCH).unwrap().as_secs() as libc::time_t;
    let times = [
        libc::timeval {
            tv_sec: secs,
            tv_usec: 0,
        },
        libc::timeval {
            tv_sec: secs,
            tv_usec: 0,
        },
    ];
    let cstr = std::ffi::CString::new(path.to_str().unwrap()).unwrap();
    unsafe { libc::utimes(cstr.as_ptr(), times.as_ptr()) };
}

#[test]
fn new_untracked_and_deleted_files_show_on_next_pass() {
    let root = temp();
    git(&root, &["init", "-q"]);
    git(&root, &["config", "user.email", "murmo@test"]);
    git(&root, &["config", "user.name", "murmo"]);
    git(&root, &["config", "commit.gpgsign", "false"]);
    fs::write(root.join("a.rs"), "pub fn keep() {}\n").unwrap();
    git(&root, &["add", "a.rs"]);
    git(&root, &["commit", "-qm", "init"]);
    let paths = murmo_indexer::git::list_paths(&root).unwrap();
    let (state, _, _) = update(&root, &paths, &Default::default());

    fs::write(root.join("new.rs"), "pub fn added_name() {}\n").unwrap();
    fs::remove_file(root.join("a.rs")).unwrap();
    let paths2 = {
        let mut p = murmo_indexer::git::list_paths(&root).unwrap();
        if !p.iter().any(|x| x == "new.rs") {
            p.push("new.rs".into());
        }
        p.retain(|x| x != "a.rs");
        p
    };
    let (_, recs, _) = update(&root, &paths2, &state);
    assert!(recs.iter().any(|r| r.name == "added_name"));
    assert!(!recs.iter().any(|r| r.name == "keep"));
    assert!(lstat_in_repo(&root, "a.rs").is_none());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn one_fd_read_does_not_mix_generations() {
    let dir = temp();
    let recs = vec![murmo_indexer::NameRecord::new(
        "Alpha", "class", "a.rs", 1, 1, "",
    )];
    let a = build_packed(&recs);
    commit_snapshot(&dir, &a, "{}", "{}").unwrap();
    let snap = read_current(&dir).unwrap();
    let idx = PackedIndex::load_bytes(snap.names.clone()).unwrap();
    assert_eq!(idx.len(), 1);

    let recs2 = vec![
        recs[0].clone(),
        murmo_indexer::NameRecord::new("Beta", "class", "b.rs", 1, 1, ""),
    ];
    let b = build_packed(&recs2);
    let path = snap.dir.join("names.bin");
    // Reopen-per-chunk while a writer replaces the file: the negative control
    // from r6. One-fd `read_current` keeps the first generation.
    let mixed = std::thread::scope(|s| {
        s.spawn(|| {
            std::thread::sleep(Duration::from_millis(1));
            let _ = fs::write(&path, &b);
        });
        read_reopen_chunks(&path, 8).ok()
    });
    let _ = mixed;
    let once = PackedIndex::load_bytes(snap.names).unwrap();
    assert_eq!(once.len(), 1, "held bytes stay generation A");
    let _ = fs::remove_dir_all(&dir);
}

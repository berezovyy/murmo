//! Idle `murmo-index`: build, rebuild, wipe, status. Not a daemon.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use murmo_indexer::exclude::EXCLUSION_VERSION;
use murmo_indexer::extract::grammar_versions;
use murmo_indexer::git::list_paths;
use murmo_indexer::incremental::{files_json, load_files_json, update};
use murmo_indexer::lock::IndexLock;
use murmo_indexer::packed::{build_packed, INDEXER_VERSION};
use murmo_indexer::snapshot::{commit_snapshot, read_current};
use serde_json::{json, Value};

fn usage() -> ExitCode {
    eprintln!("usage: murmo-index build|rebuild|wipe|status --root DIR --cache DIR");
    ExitCode::from(2)
}

fn lower_priority() {
    // SAFETY: nice() on this process only.
    unsafe {
        libc::nice(10);
    }
}

fn cache_key() -> String {
    format!(
        "indexer={INDEXER_VERSION};exclude={EXCLUSION_VERSION};grammars={}",
        grammar_versions()
    )
}

fn names_dir(cache: &Path) -> PathBuf {
    cache.join("names-v1")
}

fn meta(records: usize, files: usize, error: Option<&str>) -> String {
    json!({
        "format": "murmo-names-v1",
        "indexerVersion": INDEXER_VERSION,
        "cacheKey": cache_key(),
        "records": records,
        "files": files,
        "builtAtMs": now_ms(),
        "grammarVersions": grammar_versions(),
        "lastError": error,
    })
    .to_string()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn cmd_build(root: &Path, cache: &Path, force: bool) -> Result<(), String> {
    lower_priority();
    let dir = names_dir(cache);
    let _lock = IndexLock::acquire(&dir)?;
    let paths = list_paths(root)?;
    let previous = if force {
        Default::default()
    } else {
        read_current(&dir)
            .ok()
            .map(|s| load_files_json(&s.files))
            .unwrap_or_default()
    };
    let (state, records, rescanned) = update(root, &paths, &previous);
    let bytes = build_packed(&records);
    let meta = meta(records.len(), state.len(), None);
    let files = files_json(&state);
    let snap = commit_snapshot(&dir, &bytes, &meta, &files)?;
    println!(
        "names-v1 {} records, {} files, {} rescanned → {}",
        records.len(),
        state.len(),
        rescanned,
        snap.display()
    );
    Ok(())
}

fn cmd_wipe(cache: &Path) -> Result<(), String> {
    let dir = names_dir(cache);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    println!("wiped {}", dir.display());
    Ok(())
}

fn cmd_status(cache: &Path) -> Result<(), String> {
    let dir = names_dir(cache);
    match read_current(&dir) {
        Ok(s) => {
            let v: Value = serde_json::from_str(&s.meta).unwrap_or(json!({}));
            let age = v
                .get("builtAtMs")
                .and_then(Value::as_u64)
                .map(|t| now_ms().saturating_sub(t) / 1000);
            println!(
                "records={} files={} bytes={} ageSec={} error={}",
                v.get("records").and_then(Value::as_u64).unwrap_or(0),
                v.get("files").and_then(Value::as_u64).unwrap_or(0),
                s.names.len(),
                age.unwrap_or(0),
                v.get("lastError").and_then(Value::as_str).unwrap_or("none")
            );
            Ok(())
        }
        Err(e) => {
            println!("missing ({e})");
            Ok(())
        }
    }
}

fn arg(args: &[String], name: &str) -> Option<PathBuf> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    let cmd = args.get(1).map(String::as_str).unwrap_or("");
    let root = arg(&args, "--root")
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let cache = match arg(&args, "--cache") {
        Some(c) => c,
        None => {
            usage();
            return ExitCode::from(2);
        }
    };
    let result = match cmd {
        "build" => cmd_build(&root, &cache, false),
        "rebuild" => cmd_build(&root, &cache, true),
        "wipe" => cmd_wipe(&cache),
        "status" => cmd_status(&cache),
        _ => return usage(),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("murmo-index: {e}");
            ExitCode::from(1)
        }
    }
}

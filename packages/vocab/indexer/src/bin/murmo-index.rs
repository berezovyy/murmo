//! Idle `murmo-index`: build, rebuild, wipe, status. Not a daemon.

use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use murmo_indexer::aliases::{alias_records, merge_sources, source_counts};
use murmo_indexer::docs::{extract_docs_from, merge_docs};
use murmo_indexer::exclude::EXCLUSION_VERSION;
use murmo_indexer::extract::grammar_versions;
use murmo_indexer::git::list_paths;
use murmo_indexer::incremental::{files_json, load_files_json, update};
use murmo_indexer::lock::IndexLock;
use murmo_indexer::lsp::{run_servers, LSP_TIMEOUT_MS};
use murmo_indexer::packed::{build_packed, INDEXER_VERSION};
use murmo_indexer::snapshot::{commit_snapshot, read_current};
use serde_json::{json, Value};

fn usage() -> ExitCode {
    eprintln!(
        "usage: murmo-index build|rebuild|wipe|status --root DIR --cache DIR [--private] [--lsp-server NAME]... [--lsp-timeout-ms N]"
    );
    ExitCode::from(2)
}

fn lower_priority() {
    // SAFETY: nice() on this process only.
    unsafe {
        libc::nice(10);
    }
}

struct Flags {
    root: PathBuf,
    cache: PathBuf,
    private: bool,
    lsp_servers: Vec<String>,
    lsp_timeout_ms: u64,
}

fn cache_key(flags: &Flags) -> String {
    let lsp = flags.lsp_servers.join(",");
    format!(
        "indexer={INDEXER_VERSION};exclude={EXCLUSION_VERSION};grammars={};lsp={lsp};private={};docs=1",
        grammar_versions(),
        u8::from(flags.private),
    )
}

fn names_dir(cache: &Path) -> PathBuf {
    cache.join("names-v1")
}

fn meta(
    flags: &Flags,
    records: usize,
    files: usize,
    sources: (u64, u64, u64, u64),
    lsp_errors: &[String],
    error: Option<&str>,
) -> String {
    let (tags, lsp, docs, manifest) = sources;
    json!({
        "format": "murmo-names-v1",
        "indexerVersion": INDEXER_VERSION,
        "cacheKey": cache_key(flags),
        "records": records,
        "files": files,
        "builtAtMs": now_ms(),
        "grammarVersions": grammar_versions(),
        "lastError": error,
        "private": flags.private,
        "lspServers": flags.lsp_servers,
        "sources": {
            "tags": { "records": tags },
            "manifest": { "records": manifest },
            "lsp": { "records": lsp, "error": lsp_errors.join("; ") },
            "docs": { "records": docs },
        },
    })
    .to_string()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn cmd_build(flags: &Flags, force: bool) -> Result<(), String> {
    lower_priority();
    let dir = names_dir(&flags.cache);
    let _lock = IndexLock::acquire(&dir)?;
    let paths = list_paths(&flags.root)?;
    let previous = if force {
        Default::default()
    } else {
        read_current(&dir)
            .ok()
            .map(|s| load_files_json(&s.files))
            .unwrap_or_default()
    };
    let (state, mut records, rescanned) = update(&flags.root, &paths, &previous);
    let mut lsp_errors = Vec::new();
    if !flags.private {
        let tagged: HashSet<String> = state.keys().cloned().collect();
        if !flags.lsp_servers.is_empty() {
            for result in run_servers(
                &flags.root,
                &flags.lsp_servers,
                flags.lsp_timeout_ms,
                &tagged,
            ) {
                if let Some(err) = result.error {
                    lsp_errors.push(format!("{}: {err}", result.server));
                }
                records.extend(result.records);
            }
        }
        let (hits, _) = extract_docs_from(&flags.root, &paths);
        let (docs, _) = merge_docs(&records, &hits);
        records.extend(docs);
    }
    records.extend(alias_records(&records));
    records = merge_sources(records);
    let bytes = build_packed(&records);
    let counts = source_counts(&records);
    let err = if lsp_errors.is_empty() {
        None
    } else {
        Some(lsp_errors.join("; "))
    };
    let meta = meta(
        flags,
        records.len(),
        state.len(),
        counts,
        &lsp_errors,
        err.as_deref(),
    );
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
            let sources = v.get("sources").cloned().unwrap_or(json!({}));
            println!(
                "records={} files={} bytes={} ageSec={} error={} sources={} path={}",
                v.get("records").and_then(Value::as_u64).unwrap_or(0),
                v.get("files").and_then(Value::as_u64).unwrap_or(0),
                s.names.len(),
                age.unwrap_or(0),
                v.get("lastError").and_then(Value::as_str).unwrap_or("none"),
                sources,
                dir.display()
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

fn parse_flags(args: &[String]) -> Option<Flags> {
    let root = arg(args, "--root")
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let cache = arg(args, "--cache")?;
    let private = args.iter().any(|a| a == "--private");
    let mut lsp_servers = Vec::new();
    let mut lsp_timeout_ms = LSP_TIMEOUT_MS;
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--lsp-server" {
            if let Some(v) = args.get(i + 1) {
                lsp_servers.push(v.clone());
                i += 2;
                continue;
            }
        }
        if args[i] == "--lsp-timeout-ms" {
            if let Some(v) = args.get(i + 1).and_then(|s| s.parse().ok()) {
                lsp_timeout_ms = v;
                i += 2;
                continue;
            }
        }
        i += 1;
    }
    Some(Flags {
        root,
        cache,
        private,
        lsp_servers,
        lsp_timeout_ms,
    })
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    let cmd = args.get(1).map(String::as_str).unwrap_or("");
    let Some(flags) = parse_flags(&args) else {
        return usage();
    };
    let result = match cmd {
        "build" => cmd_build(&flags, false),
        "rebuild" => cmd_build(&flags, true),
        "wipe" => cmd_wipe(&flags.cache),
        "status" => cmd_status(&flags.cache),
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

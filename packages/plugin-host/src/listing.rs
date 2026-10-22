//! Project listing: root only, gitignore, no symlink escape, paging.

use std::fs;
use std::path::Path;

use serde_json::{json, Value};

fn gitignore_denied(rel: &str, rules: &[String]) -> bool {
    rules.iter().any(|rule| {
        let rule = rule.trim();
        if rule.is_empty() || rule.starts_with('#') {
            return false;
        }
        rel == rule || rel.starts_with(&(rule.trim_end_matches('/').to_string() + "/"))
    })
}

fn walk(
    root: &Path,
    dir: &Path,
    out: &mut Vec<Value>,
    rules: &[String],
    cap: usize,
) -> Result<(), String> {
    if out.len() >= cap {
        return Ok(());
    }
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let meta = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        if gitignore_denied(&rel, rules) {
            continue;
        }
        if meta.is_dir() {
            out.push(json!({"path": rel, "bytes": 0, "directory": true}));
            walk(root, &path, out, rules, cap)?;
        } else if meta.is_file() {
            out.push(json!({"path": rel, "bytes": meta.len(), "directory": false}));
        }
        if out.len() >= cap {
            break;
        }
    }
    Ok(())
}

pub fn handle(root: &str, query: &Value) -> Value {
    let root = match fs::canonicalize(root) {
        Ok(p) => p,
        Err(e) => return json!({"status": "denied", "reason": e.to_string()}),
    };
    let prefix = query.get("prefix").and_then(Value::as_str).unwrap_or("");
    if prefix.contains("..")
        || prefix.starts_with('/')
        || prefix.contains('\\')
        || prefix.contains('\0')
    {
        return json!({"status": "denied", "reason": "path must be relative, with no traversal"});
    }
    let mut rules = Vec::new();
    if let Ok(text) = fs::read_to_string(root.join(".gitignore")) {
        rules.extend(text.lines().map(str::to_string));
    }
    let mut files = Vec::new();
    if let Err(e) = walk(&root, &root, &mut files, &rules, 10_000) {
        return json!({"status": "error", "reason": e});
    }
    if !prefix.is_empty() {
        files.retain(|row| {
            row.get("path").and_then(Value::as_str).is_some_and(|p| {
                p == prefix || p.starts_with(&(prefix.to_string() + "/")) || p.starts_with(prefix)
            })
        });
    }
    let total = files.len();
    let offset = query.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let limit = query
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(256)
        .min(256) as usize;
    let page = files
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<_>>();
    let id = format!("{:x}", total.wrapping_mul(31).wrapping_add(offset));
    json!({
        "status": "ok",
        "snapshotId": id,
        "entries": page,
        "total": total,
        "offset": offset,
    })
}

pub fn trusted_root(root: &str, candidate: &Path) -> bool {
    let Ok(root) = fs::canonicalize(root) else {
        return false;
    };
    let Ok(path) = fs::canonicalize(candidate) else {
        return false;
    };
    path == root || path.starts_with(&root)
}

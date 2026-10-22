//! Read-only git queries inside the trusted project root (FEEDBACK C3).

use std::process::Command;

use serde_json::{json, Value};

use crate::listing::trusted_root;

fn git(root: &str, args: &[&str]) -> Result<String, String> {
    if !trusted_root(root, std::path::Path::new(root)) {
        return Err("worktree outside trusted root".into());
    }
    let out = Command::new("git")
        .args(args)
        .current_dir(root)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub fn handle(root: &str, spec: &Value) -> Value {
    let kind = spec.get("kind").and_then(Value::as_str).unwrap_or("");
    match kind {
        "branch" => match git(root, &["rev-parse", "--abbrev-ref", "HEAD"]) {
            Ok(branch) => json!({"status": "ok", "branch": branch}),
            Err(e) => json!({"status": "error", "reason": e}),
        },
        "status" => {
            let branch =
                git(root, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_else(|_| "HEAD".into());
            let porcelain = git(root, &["status", "--porcelain"]).unwrap_or_default();
            json!({
                "status": "ok",
                "branch": branch,
                "dirty": !porcelain.is_empty(),
                "ahead": 0,
                "behind": 0,
            })
        }
        "log" => {
            let limit = spec
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(10)
                .min(20);
            match git(root, &["log", &format!("-{limit}"), "--pretty=%s"]) {
                Ok(text) => {
                    let subjects: Vec<String> = text.lines().map(str::to_string).collect();
                    json!({"status": "ok", "subjects": subjects})
                }
                Err(e) => json!({"status": "error", "reason": e}),
            }
        }
        "changed" => match git(root, &["diff", "--name-only", "HEAD"]) {
            Ok(text) => {
                let paths: Vec<String> = text
                    .lines()
                    .filter(|l| !l.is_empty())
                    .map(str::to_string)
                    .collect();
                json!({"status": "ok", "paths": paths})
            }
            Err(e) => json!({"status": "error", "reason": e}),
        },
        _ => json!({"status": "denied", "reason": "unknown git query"}),
    }
}

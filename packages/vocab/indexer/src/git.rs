//! `git ls-files` plus eligible untracked files (r9 freshness: tracked-only missed new files).

use std::path::Path;
use std::process::Command;

use crate::exclude::path_allowed;

pub fn list_paths(root: &Path) -> Result<Vec<String>, String> {
    let tracked = git_z(root, &["ls-files", "-z"])?;
    let others =
        git_z(root, &["ls-files", "-z", "--others", "--exclude-standard"]).unwrap_or_default();
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for p in tracked.into_iter().chain(others) {
        if !path_allowed(&p) || !seen.insert(p.clone()) {
            continue;
        }
        out.push(p);
    }
    Ok(out)
}

fn git_z(root: &Path, args: &[&str]) -> Result<Vec<String>, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("git ls-files failed".into());
    }
    Ok(out
        .stdout
        .split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .filter_map(|s| String::from_utf8(s.to_vec()).ok())
        .collect())
}

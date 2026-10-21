//! The canonical text a project approval pins (port of `src/trust.ts`). The
//! JS and Rust texts are identical byte for byte, so an approval made by
//! `murmo trust` holds in the Codex wrapper too.

use std::collections::BTreeMap;

pub const TRUST_MANIFEST_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SymlinkHop {
    pub path: String,
    pub target: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PinnedFile {
    pub path: String,
    pub resolved: String,
    pub links: Vec<SymlinkHop>,
    pub sha256: String,
}

/// `JSON.stringify` of a string; serde_json escapes the same characters.
fn quote(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

fn pinned(file: &PinnedFile) -> String {
    let links: Vec<String> = file
        .links
        .iter()
        .map(|l| {
            format!(
                "{{\"path\":{},\"target\":{}}}",
                quote(&l.path),
                quote(&l.target)
            )
        })
        .collect();
    format!(
        "{{\"path\":{},\"resolved\":{},\"links\":[{}],\"sha256\":{}}}",
        quote(&file.path),
        quote(&file.resolved),
        links.join(","),
        quote(&file.sha256)
    )
}

/// References sorted by path in code point order and listed once (the first wins).
pub fn trust_manifest(config: &PinnedFile, references: &[PinnedFile]) -> String {
    let mut unique: BTreeMap<&str, &PinnedFile> = BTreeMap::new();
    for r in references {
        unique.entry(r.path.as_str()).or_insert(r);
    }
    let refs: Vec<String> = unique.values().map(|r| pinned(r)).collect();
    format!(
        "{{\"schema\":{TRUST_MANIFEST_VERSION},\"config\":{},\"references\":[{}]}}",
        pinned(config),
        refs.join(",")
    )
}

//! lstat sweep on (mtime, size, inode, ctime). Hash and re-scan when the tuple
//! changes. A same-size edit with a restored mtime is caught by ctime (E11).

use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::exclude::MAX_FILE_BYTES;
use crate::extract::scan_file;
use crate::record::{record_from_json, NameRecord};

#[derive(Clone, Debug)]
pub struct FileSig {
    pub mtime_ns: u128,
    pub size: u64,
    pub ino: u64,
    pub ctime_ns: u128,
}

impl FileSig {
    pub fn from_meta(meta: &fs::Metadata) -> Self {
        Self {
            mtime_ns: meta.mtime() as u128 * 1_000_000_000 + meta.mtime_nsec() as u128,
            size: meta.len(),
            ino: meta.ino(),
            ctime_ns: meta.ctime() as u128 * 1_000_000_000 + meta.ctime_nsec() as u128,
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "mtime": self.mtime_ns.to_string(),
            "size": self.size,
            "ino": self.ino.to_string(),
            "ctime": self.ctime_ns.to_string(),
        })
    }

    pub fn from_json(v: &Value) -> Option<Self> {
        let o = v.as_object()?;
        Some(Self {
            mtime_ns: o.get("mtime")?.as_str()?.parse().ok()?,
            size: o.get("size")?.as_u64()?,
            ino: o.get("ino")?.as_str()?.parse().ok()?,
            ctime_ns: o.get("ctime")?.as_str()?.parse().ok()?,
        })
    }
}

pub struct FileState {
    pub sig: FileSig,
    pub records: Vec<NameRecord>,
}

/// lstat without following a symlink. None if missing, not a regular file, or
/// the symlink would leave `root`.
pub fn lstat_in_repo(root: &Path, rel: &str) -> Option<(PathBuf, fs::Metadata)> {
    let path = root.join(rel);
    let meta = fs::symlink_metadata(&path).ok()?;
    if meta.file_type().is_symlink() {
        let target = fs::read_link(&path).ok()?;
        let resolved = if target.is_absolute() {
            target
        } else {
            path.parent()?.join(target)
        };
        let canon_root = root.canonicalize().ok()?;
        let canon = resolved.canonicalize().ok()?;
        if !canon.starts_with(&canon_root) {
            return None;
        }
        return None;
    }
    if !meta.is_file() {
        return None;
    }
    Some((path, meta))
}

pub fn load_files_json(text: &str) -> HashMap<String, FileState> {
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        return HashMap::new();
    };
    let Some(obj) = v.as_object() else {
        return HashMap::new();
    };
    let mut out = HashMap::new();
    for (k, val) in obj {
        let Some(o) = val.as_object() else { continue };
        let Some(sig) = o.get("sig").and_then(FileSig::from_json) else {
            continue;
        };
        let records = o
            .get("records")
            .and_then(Value::as_array)
            .map(|arr| arr.iter().filter_map(record_from_json).collect())
            .unwrap_or_default();
        out.insert(k.clone(), FileState { sig, records });
    }
    out
}

pub fn files_json(state: &HashMap<String, FileState>) -> String {
    let mut map = serde_json::Map::new();
    for (k, v) in state {
        let records: Vec<Value> = v.records.iter().map(NameRecord::to_json).collect();
        map.insert(
            k.clone(),
            json!({ "sig": v.sig.to_json(), "records": records }),
        );
    }
    Value::Object(map).to_string()
}

pub fn content_hash(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

/// Re-scan files whose (mtime, size, inode, ctime) tuple changed; drop deleted
/// paths; add new ones. Returns all records after the pass.
pub fn update(
    root: &Path,
    paths: &[String],
    previous: &HashMap<String, FileState>,
) -> (HashMap<String, FileState>, Vec<NameRecord>, usize) {
    let mut next = HashMap::new();
    let mut rescanned = 0usize;
    for rel in paths {
        let Some((path, meta)) = lstat_in_repo(root, rel) else {
            continue;
        };
        if meta.len() > MAX_FILE_BYTES {
            continue;
        }
        let sig = FileSig::from_meta(&meta);
        if let Some(old) = previous.get(rel) {
            if old.sig.mtime_ns == sig.mtime_ns
                && old.sig.size == sig.size
                && old.sig.ino == sig.ino
                && old.sig.ctime_ns == sig.ctime_ns
            {
                next.insert(
                    rel.clone(),
                    FileState {
                        sig,
                        records: old.records.clone(),
                    },
                );
                continue;
            }
        }
        let Ok(bytes) = fs::read(&path) else { continue };
        let Some((records, _)) = scan_file(rel, &bytes) else {
            continue;
        };
        rescanned += 1;
        next.insert(rel.clone(), FileState { sig, records });
    }
    let mut all = Vec::new();
    for st in next.values() {
        all.extend(st.records.iter().cloned());
    }
    (next, all, rescanned)
}

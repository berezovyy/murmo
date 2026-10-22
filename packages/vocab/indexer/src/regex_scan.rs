//! Regex/path fallback for languages without a grammar (no kinds).

use std::collections::HashMap;

use crate::exclude::MAX_NAME_CHARS;
use crate::record::NameRecord;

const IDENT: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
const IDENT_CONT: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_$";

/// Lexical identifier counts, skipping comments and quoted strings (r6 lexer).
pub fn count_identifiers(bytes: &[u8]) -> HashMap<String, u32> {
    let mut counts = HashMap::new();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'/' && i + 1 < bytes.len() {
            if bytes[i + 1] == b'/' {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
                continue;
            }
            if bytes[i + 1] == b'*' {
                i += 2;
                while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                    i += 1;
                }
                i = i.saturating_add(2);
                continue;
            }
        }
        if b == b'#' {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if b == b'"' || b == b'\'' || b == b'`' {
            let q = b;
            i += 1;
            while i < bytes.len() && bytes[i] != q {
                if bytes[i] == b'\\' {
                    i += 2;
                } else {
                    i += 1;
                }
            }
            i += 1;
            continue;
        }
        if IDENT.contains(&b) {
            let start = i;
            i += 1;
            while i < bytes.len() && IDENT_CONT.contains(&bytes[i]) {
                i += 1;
            }
            if let Ok(s) = std::str::from_utf8(&bytes[start..i]) {
                if s.len() >= 2 && s.len() <= MAX_NAME_CHARS {
                    *counts.entry(s.to_string()).or_insert(0) += 1;
                }
            }
            continue;
        }
        i += 1;
    }
    counts
}

/// Identifiers plus the path itself, kind `identifier` / `path`. No source text.
pub fn regex_names(path: &str, bytes: &[u8]) -> Vec<NameRecord> {
    let counts = count_identifiers(bytes);
    let mut rows: Vec<NameRecord> = counts
        .iter()
        .map(|(name, refs)| NameRecord {
            name: name.clone(),
            kind: "identifier".into(),
            file: path.to_string(),
            line: 1,
            refs: *refs,
            owner: String::new(),
        })
        .collect();
    if let Some(base) = path.rsplit('/').next() {
        let stem = base.rsplit_once('.').map(|(s, _)| s).unwrap_or(base);
        if stem.len() >= 2 {
            rows.push(NameRecord {
                name: stem.to_string(),
                kind: "path".into(),
                file: path.to_string(),
                line: 1,
                refs: 1,
                owner: String::new(),
            });
        }
    }
    rows
}

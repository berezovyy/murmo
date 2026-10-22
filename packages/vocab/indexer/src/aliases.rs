//! Merge sources by rank and build 2–4 word alias keys from identifier splits
//! plus docs phrases.

use std::collections::{HashMap, HashSet};

use crate::record::NameRecord;
use crate::source::{source_rank, SOURCE_DOCS, SOURCE_LSP, SOURCE_MANIFEST, SOURCE_TAGS};
use crate::split::{split_words, word_key};

fn packed_key(rec: &NameRecord) -> String {
    if rec.key.is_empty() {
        word_key(&rec.name)
    } else {
        rec.key.clone()
    }
}

/// Dedup by (name, file, line, key). Higher source rank wins kind/location;
/// source bits are unioned.
pub fn merge_sources(records: Vec<NameRecord>) -> Vec<NameRecord> {
    let mut by: HashMap<(String, String, u32, String), NameRecord> = HashMap::new();
    for rec in records {
        let k = (
            rec.name.clone(),
            rec.file.clone(),
            rec.line,
            packed_key(&rec),
        );
        if let Some(existing) = by.get_mut(&k) {
            if source_rank(rec.source) < source_rank(existing.source) {
                existing.kind = rec.kind;
                existing.owner = rec.owner;
                existing.line = rec.line;
                existing.file = rec.file;
            }
            existing.refs = existing.refs.max(rec.refs);
            existing.source |= rec.source;
        } else {
            by.insert(k, rec);
        }
    }
    by.into_values().collect()
}

/// Identifier splits of 2–4 words become extra alias keys of those names.
pub fn alias_records(records: &[NameRecord]) -> Vec<NameRecord> {
    let mut out = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();
    for rec in records {
        let words = split_words(&rec.name);
        if !(2..=4).contains(&words.len()) {
            continue;
        }
        let key = words.join(" ");
        if key.is_empty() || packed_key(rec) == key {
            continue;
        }
        if !seen.insert((rec.name.clone(), key.clone())) {
            continue;
        }
        let mut alias = rec.clone();
        alias.key = key;
        out.push(alias);
    }
    out
}

pub fn source_counts(records: &[NameRecord]) -> (u64, u64, u64, u64) {
    let mut tags = 0u64;
    let mut lsp = 0u64;
    let mut docs = 0u64;
    let mut manifest = 0u64;
    for r in records {
        if r.source & SOURCE_TAGS != 0 {
            tags += 1;
        }
        if r.source & SOURCE_LSP != 0 {
            lsp += 1;
        }
        if r.source & SOURCE_DOCS != 0 {
            docs += 1;
        }
        if r.source & SOURCE_MANIFEST != 0 {
            manifest += 1;
        }
    }
    (tags, lsp, docs, manifest)
}

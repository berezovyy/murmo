//! Markdown term extractor: headings, backticks, emphasis. Grammar Guard
//! scoring (`I + P + 2E`) with locations. Fences are skipped. Never stores
//! source lines.

use std::collections::HashMap;
use std::path::Path;

use crate::exclude::{path_allowed, MAX_NAME_CHARS};
use crate::record::NameRecord;
use crate::source::SOURCE_DOCS;
use crate::split::word_key;

/// 256 KiB per doc file (phase 38).
pub const MAX_DOC_BYTES: u64 = 256 * 1024;
/// Unresolved terms kept per repo.
pub const MAX_UNRESOLVED_TERMS: usize = 500;
const EMPHASIS_MIN: usize = 3;
const EMPHASIS_MAX: usize = 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HitKind {
    Heading,
    Backtick,
    Emphasis,
    Prose,
}

#[derive(Clone, Debug)]
pub struct DocHit {
    pub term: String,
    pub file: String,
    pub line: u32,
    pub kind: HitKind,
}

#[derive(Clone, Debug, Default)]
pub struct DocsStats {
    pub files: usize,
    pub hits: usize,
    pub aliases: usize,
    pub terms: usize,
}

pub fn is_doc_path(path: &str) -> bool {
    if !path_allowed(path) {
        return false;
    }
    let lower = path.to_ascii_lowercase();
    if !lower.ends_with(".md") {
        return false;
    }
    let base = path.rsplit('/').next().unwrap_or(path);
    let base_l = base.to_ascii_lowercase();
    base_l == "readme.md"
        || base_l == "claude.md"
        || base_l == "agents.md"
        || lower.starts_with("docs/")
        || !path.contains('/')
}

/// Extract terms from one Markdown file. Fenced code is skipped.
pub fn extract_markdown(path: &str, text: &str) -> Vec<DocHit> {
    let mut hits = Vec::new();
    let mut fence = false;
    for (i, raw_line) in text.lines().enumerate() {
        let line_no = i as u32 + 1;
        let trimmed = raw_line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fence = !fence;
            continue;
        }
        if fence {
            continue;
        }
        if let Some(heading) = atx_heading(trimmed) {
            push_hit(&mut hits, heading, path, line_no, HitKind::Heading);
        }
        for term in inline_backticks(raw_line) {
            push_hit(&mut hits, &term, path, line_no, HitKind::Backtick);
        }
        for term in emphasis_spans(raw_line) {
            push_hit(&mut hits, &term, path, line_no, HitKind::Emphasis);
        }
        for phrase in prose_phrases(raw_line) {
            push_hit(&mut hits, &phrase, path, line_no, HitKind::Prose);
        }
    }
    hits
}

fn atx_heading(line: &str) -> Option<&str> {
    let hashes = line.bytes().take_while(|b| *b == b'#').count();
    if !(1..=3).contains(&hashes) {
        return None;
    }
    let rest = line.get(hashes..)?;
    if !rest.starts_with(' ') && !rest.starts_with('\t') {
        return None;
    }
    let body = rest.trim().trim_end_matches('#').trim();
    if body.is_empty() {
        None
    } else {
        Some(body)
    }
}

fn inline_backticks(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'`' {
            let mut n = 1;
            while i + n < bytes.len() && bytes[i + n] == b'`' {
                n += 1;
            }
            if n >= 3 {
                i += n;
                continue;
            }
            if let Some(end) = line[i + n..].find('`') {
                let inner = &line[i + n..i + n + end];
                if !inner.contains('\n') && inner.len() <= MAX_NAME_CHARS && !inner.is_empty() {
                    out.push(inner.trim().to_string());
                }
                i = i + n + end + 1;
                continue;
            }
        }
        i += 1;
    }
    out
}

fn emphasis_spans(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    collect_wrapped(line, "**", &mut out);
    collect_wrapped(line, "__", &mut out);
    collect_wrapped_single(line, '*', &mut out);
    collect_wrapped_single(line, '_', &mut out);
    out
}

fn collect_wrapped(line: &str, delim: &str, out: &mut Vec<String>) {
    let mut rest = line;
    while let Some(start) = rest.find(delim) {
        let after = &rest[start + delim.len()..];
        if let Some(end) = after.find(delim) {
            let inner = &after[..end];
            let chars = inner.chars().count();
            if (EMPHASIS_MIN..=EMPHASIS_MAX).contains(&chars) && !inner.contains('\n') {
                out.push(inner.trim().to_string());
            }
            rest = &after[end + delim.len()..];
        } else {
            break;
        }
    }
}

fn collect_wrapped_single(line: &str, mark: char, out: &mut Vec<String>) {
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == mark {
            if i + 1 < chars.len() && chars[i + 1] == mark {
                i += 2;
                continue;
            }
            let mut j = i + 1;
            while j < chars.len() && chars[j] != mark {
                j += 1;
            }
            if j < chars.len() && j > i + 1 {
                let inner: String = chars[i + 1..j].iter().collect();
                let n = inner.chars().count();
                if (EMPHASIS_MIN..=EMPHASIS_MAX).contains(&n) && !inner.contains('\n') {
                    out.push(inner.trim().to_string());
                }
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
}

fn prose_phrases(line: &str) -> Vec<String> {
    let cleaned: String = line
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' {
                c
            } else {
                ' '
            }
        })
        .collect();
    let words: Vec<&str> = cleaned
        .split_whitespace()
        .filter(|w| w.len() >= 2)
        .collect();
    let mut out = Vec::new();
    for n in 2..=3 {
        if words.len() < n {
            continue;
        }
        for w in words.windows(n) {
            out.push(w.join(" "));
        }
    }
    out
}

fn push_hit(hits: &mut Vec<DocHit>, term: &str, file: &str, line: u32, kind: HitKind) {
    let term = term.trim();
    if term.is_empty() || term.len() > MAX_NAME_CHARS {
        return;
    }
    hits.push(DocHit {
        term: term.to_string(),
        file: file.to_string(),
        line,
        kind,
    });
}

fn score(i: u32, p: u32, e: u32, f: u32) -> i32 {
    if i > 0 && p > 0 {
        (i + p + 2 * e) as i32
    } else if e > 0 && p >= 2 {
        (p + 2 * e) as i32
    } else if i >= 5 && f >= 2 {
        i as i32
    } else if e > 0 {
        (2 * e) as i32
    } else if p >= 2 {
        p as i32
    } else {
        0
    }
}

/// Merge doc hits into aliases of known names, else unresolved `term` records.
pub fn merge_docs(known: &[NameRecord], hits: &[DocHit]) -> (Vec<NameRecord>, DocsStats) {
    let mut by_key: HashMap<String, &NameRecord> = HashMap::new();
    for r in known {
        let k = if r.key.is_empty() {
            word_key(&r.name)
        } else {
            r.key.clone()
        };
        if !k.is_empty() {
            by_key.entry(k).or_insert(r);
        }
    }
    let mut i_count: HashMap<String, u32> = HashMap::new();
    let mut p_count: HashMap<String, u32> = HashMap::new();
    let mut e_count: HashMap<String, u32> = HashMap::new();
    let mut files_of: HashMap<String, std::collections::HashSet<String>> = HashMap::new();
    let mut best: HashMap<String, &DocHit> = HashMap::new();

    for hit in hits {
        if hit.kind == HitKind::Prose && word_key(&hit.term).split_whitespace().count() < 2 {
            continue;
        }
        let k = word_key(&hit.term);
        if k.is_empty() {
            continue;
        }
        match hit.kind {
            HitKind::Heading | HitKind::Backtick | HitKind::Emphasis => {
                *e_count.entry(k.clone()).or_insert(0) += 1;
            }
            HitKind::Prose => {
                *p_count.entry(k.clone()).or_insert(0) += 1;
            }
        }
        files_of
            .entry(k.clone())
            .or_default()
            .insert(hit.file.clone());
        best.entry(k).or_insert(hit);
    }
    for r in known {
        let k = if r.key.is_empty() {
            word_key(&r.name)
        } else {
            r.key.clone()
        };
        if !k.is_empty() {
            *i_count.entry(k).or_insert(0) += 1;
        }
    }

    let mut aliases = Vec::new();
    let mut unresolved: Vec<(i32, NameRecord)> = Vec::new();
    let mut stats = DocsStats {
        hits: hits.len(),
        ..DocsStats::default()
    };
    let mut seen_files = std::collections::HashSet::new();

    for (k, hit) in &best {
        seen_files.insert(hit.file.as_str());
        let i = *i_count.get(k).unwrap_or(&0);
        let p = *p_count.get(k).unwrap_or(&0);
        let e = *e_count.get(k).unwrap_or(&0);
        let f = files_of.get(k).map(|s| s.len() as u32).unwrap_or(0);
        let s = score(i, p, e, f);
        if let Some(name) = by_key.get(k) {
            let mut rec = (*name).clone();
            rec.source |= SOURCE_DOCS;
            rec.key = k.clone();
            rec.file = hit.file.clone();
            rec.line = hit.line;
            aliases.push(rec);
            stats.aliases += 1;
        } else if e > 0 || (i > 0 && p > 0) {
            unresolved.push((
                s,
                NameRecord {
                    name: hit.term.clone(),
                    kind: "term".into(),
                    file: hit.file.clone(),
                    line: hit.line,
                    refs: (p + e).max(1),
                    owner: String::new(),
                    source: SOURCE_DOCS,
                    key: k.clone(),
                },
            ));
        }
    }
    stats.files = seen_files.len();
    unresolved.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.name.cmp(&b.1.name)));
    unresolved.truncate(MAX_UNRESOLVED_TERMS);
    stats.terms = unresolved.len();
    let mut out = aliases;
    out.extend(unresolved.into_iter().map(|(_, r)| r));
    (out, stats)
}

pub fn extract_docs_from(root: &Path, paths: &[String]) -> (Vec<DocHit>, usize) {
    let mut hits = Vec::new();
    let mut files = 0usize;
    for rel in paths {
        if !is_doc_path(rel) {
            continue;
        }
        let path = root.join(rel);
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if meta.len() > MAX_DOC_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let text = String::from_utf8_lossy(&bytes);
        let found = extract_markdown(rel, &text);
        if !found.is_empty() {
            files += 1;
            hits.extend(found);
        }
    }
    (hits, files)
}

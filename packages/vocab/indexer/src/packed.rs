//! names-v1 packed bytes. Header is 12 little-endian u32s (48 bytes).

use std::collections::{BTreeMap, HashSet};

use crate::record::NameRecord;
use crate::source::SOURCE_TAGS;
use crate::split::word_key;

pub const NAMES_MAGIC: u32 = 0x4d55_524d;
pub const NAMES_HEADER_BYTES: usize = 48;
pub const NAMES_BIN: &str = "names.bin";
pub const NAMES_META: &str = "meta.json";
pub const NAMES_FILES: &str = "files.json";
pub const NAMES_CURRENT: &str = "CURRENT";
pub const INDEXER_VERSION: u32 = 3;

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(b[at..at + 4].try_into().unwrap())
}

fn push_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

/// UTF-16 trigram hashes (`^key$`), matching JS `gramCodes` and r13 names.rs.
pub fn gram_codes(s: &str) -> Vec<u32> {
    let padded: Vec<u16> = format!("^{s}$").encode_utf16().collect();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for w in padded.windows(3) {
        let g = (w[0] as u32)
            .wrapping_mul(65599)
            .wrapping_add(w[1] as u32)
            .wrapping_mul(65599)
            .wrapping_add(w[2] as u32);
        if seen.insert(g) {
            out.push(g);
        }
    }
    out
}

fn bloom_hashes(s: &str) -> (u32, u32) {
    let mut a: u32 = 2_166_136_261;
    let mut b: u32 = 0x9e37_79b9;
    for c in s.encode_utf16() {
        a = (a ^ c as u32).wrapping_mul(16_777_619);
        b = (b ^ c as u32).wrapping_mul(2_246_822_519);
    }
    (a, b | 1)
}

fn bloom_create(names: &[String]) -> Vec<u8> {
    let bits_len = ((names.len() * 12).div_ceil(8)).max(1);
    let mut bits = vec![0u8; bits_len];
    let total_bits = bits.len() * 8;
    for s in names {
        let (a, b) = bloom_hashes(s);
        for i in 0u32..7 {
            let n = a.wrapping_add(i.wrapping_mul(b)) as usize % total_bits;
            bits[n >> 3] |= 1 << (n & 7);
        }
    }
    bits
}

pub fn bloom_has(bits: &[u8], s: &str) -> bool {
    if bits.is_empty() {
        return false;
    }
    let total_bits = bits.len() * 8;
    let (a, b) = bloom_hashes(s);
    for i in 0u32..7 {
        let n = a.wrapping_add(i.wrapping_mul(b)) as usize % total_bits;
        if bits[n >> 3] & (1 << (n & 7)) == 0 {
            return false;
        }
    }
    true
}

fn member_of(name: &str) -> String {
    if let Some((_, rest)) = name.rsplit_once("::") {
        word_key(rest)
    } else {
        String::new()
    }
}

struct PackedRow {
    name: String,
    key: String,
    kind: String,
    file: String,
    line: u32,
    refs: u32,
    member: String,
    source: u8,
}

/// Build names.bin. Records are sorted by name. Source text is never stored.
/// String blob is name, key, kind, file, member, source (decimal). A sixth
/// field is a compatible extension of the r13 layout (old readers ignore it).
pub fn build_packed(records: &[NameRecord]) -> Vec<u8> {
    let mut entries: Vec<PackedRow> = records
        .iter()
        .map(|r| {
            let key = if r.key.is_empty() {
                word_key(&r.name)
            } else {
                r.key.clone()
            };
            PackedRow {
                name: r.name.clone(),
                key,
                kind: r.kind.clone(),
                file: r.file.clone(),
                line: r.line,
                refs: r.refs,
                member: if r.owner.is_empty() {
                    member_of(&r.name)
                } else {
                    word_key(r.owner.rsplit([':', '.']).next().unwrap_or(&r.owner))
                },
                source: if r.source == 0 { SOURCE_TAGS } else { r.source },
            }
        })
        .collect();
    entries.sort_by(|a, b| a.name.cmp(&b.name).then(a.key.cmp(&b.key)));
    let names: Vec<String> = entries.iter().map(|e| e.name.clone()).collect();
    let bloom = bloom_create(&names);

    let mut parts: Vec<Vec<u8>> = Vec::with_capacity(entries.len());
    let mut offsets = vec![0u32];
    let mut refs = Vec::with_capacity(entries.len());
    let mut lines = Vec::with_capacity(entries.len());
    let mut count = Vec::with_capacity(entries.len());
    let mut grams: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
    for (id, e) in entries.iter().enumerate() {
        let src = e.source.to_string();
        let blob = [
            e.name.as_str(),
            e.key.as_str(),
            e.kind.as_str(),
            e.file.as_str(),
            e.member.as_str(),
            src.as_str(),
        ]
        .join("\0");
        let bytes = blob.into_bytes();
        let next = offsets[id] + bytes.len() as u32;
        offsets.push(next);
        parts.push(bytes);
        refs.push(e.refs);
        lines.push(e.line);
        count.push(1u32);
        for g in gram_codes(&e.key) {
            grams.entry(g).or_default().push(id as u32);
        }
    }
    let keys: Vec<u32> = grams.keys().copied().collect();
    let mut po = vec![0u32];
    let mut posts = Vec::new();
    for g in &keys {
        posts.extend_from_slice(grams.get(g).map(|v| v.as_slice()).unwrap_or(&[]));
        po.push(posts.len() as u32);
    }
    let strings_len: u32 = parts.iter().map(|p| p.len() as u32).sum();

    let mut out = Vec::new();
    push_u32(&mut out, NAMES_MAGIC);
    push_u32(&mut out, entries.len() as u32);
    push_u32(&mut out, keys.len() as u32);
    push_u32(&mut out, posts.len() as u32);
    push_u32(&mut out, strings_len);
    push_u32(&mut out, bloom.len() as u32);
    for _ in 0..6 {
        push_u32(&mut out, 0);
    }
    for v in offsets
        .iter()
        .chain(refs.iter())
        .chain(lines.iter())
        .chain(count.iter())
    {
        push_u32(&mut out, *v);
    }
    for v in keys.iter().chain(po.iter()).chain(posts.iter()) {
        push_u32(&mut out, *v);
    }
    for p in &parts {
        out.extend_from_slice(p);
    }
    out.extend_from_slice(&bloom);
    out
}

#[derive(Clone, Debug)]
pub struct PackedEntry {
    pub name: String,
    pub key: String,
    pub kind: String,
    pub file: String,
    pub member: String,
    pub refs: u32,
    pub line: u32,
    pub locations: u32,
    pub source: u8,
}

pub struct PackedIndex {
    b: Vec<u8>,
    n: usize,
    g: usize,
    offsets: usize,
    refs: usize,
    lines: usize,
    duplicates: usize,
    grams: usize,
    po: usize,
    posts: usize,
    strings: usize,
    bloom: usize,
    bloom_len: usize,
    counts: Vec<u16>,
    touched: Vec<usize>,
}

impl PackedIndex {
    pub fn load_bytes(b: Vec<u8>) -> Result<Self, String> {
        if b.len() < NAMES_HEADER_BYTES {
            return Err("names index too small".into());
        }
        if u32_at(&b, 0) != NAMES_MAGIC {
            return Err("bad names index magic".into());
        }
        let n = u32_at(&b, 4) as usize;
        let g = u32_at(&b, 8) as usize;
        let np = u32_at(&b, 12) as usize;
        let strings_len = u32_at(&b, 16) as usize;
        let bloom_len = u32_at(&b, 20) as usize;
        let offsets = NAMES_HEADER_BYTES;
        let refs = offsets + 4 * (n + 1);
        let lines = refs + 4 * n;
        let duplicates = lines + 4 * n;
        let grams = duplicates + 4 * n;
        let po = grams + 4 * g;
        let posts = po + 4 * (g + 1);
        let strings = posts + 4 * np;
        let bloom = strings + strings_len;
        if bloom + bloom_len > b.len() {
            return Err("names index truncated".into());
        }
        Ok(Self {
            b,
            n,
            g,
            offsets,
            refs,
            lines,
            duplicates,
            grams,
            po,
            posts,
            strings,
            bloom,
            bloom_len,
            counts: vec![0; n],
            touched: Vec::with_capacity(n.min(4096)),
        })
    }

    pub fn load_path(path: &std::path::Path) -> Result<Self, String> {
        let b = std::fs::read(path).map_err(|e| e.to_string())?;
        Self::load_bytes(b)
    }

    pub fn len(&self) -> usize {
        self.n
    }

    pub fn is_empty(&self) -> bool {
        self.n == 0
    }

    pub fn resident_bytes(&self) -> usize {
        self.b.capacity()
            + self.counts.capacity() * 2
            + self.touched.capacity() * std::mem::size_of::<usize>()
    }

    pub fn exact_name(&self, s: &str) -> bool {
        bloom_has(&self.b[self.bloom..self.bloom + self.bloom_len], s)
    }

    pub fn entry(&self, id: usize) -> PackedEntry {
        let start = self.strings + u32_at(&self.b, self.offsets + 4 * id) as usize;
        let end = self.strings + u32_at(&self.b, self.offsets + 4 * (id + 1)) as usize;
        let text = std::str::from_utf8(&self.b[start..end]).unwrap_or("");
        let mut fields = text.split('\0');
        let name = fields.next().unwrap_or("").to_string();
        let key = fields.next().unwrap_or("").to_string();
        let kind = fields.next().unwrap_or("").to_string();
        let file = fields.next().unwrap_or("").to_string();
        let member = fields.next().unwrap_or("").to_string();
        let source = fields
            .next()
            .and_then(|s| s.parse().ok())
            .unwrap_or(SOURCE_TAGS);
        PackedEntry {
            name,
            key,
            kind,
            file,
            member,
            refs: u32_at(&self.b, self.refs + 4 * id),
            line: u32_at(&self.b, self.lines + 4 * id),
            locations: u32_at(&self.b, self.duplicates + 4 * id),
            source,
        }
    }

    /// Trigram overlap retrieval. `limit` is capped at 96. Cooperative
    /// `budget_us` (0 = no budget). A timeout drops the whole answer.
    pub fn retrieve(
        &mut self,
        key: &str,
        limit: usize,
        budget_us: u64,
    ) -> Result<(Vec<usize>, usize), SearchFail> {
        use std::time::{Duration, Instant};
        let started = Instant::now();
        let limit = limit.min(96);
        self.touched.clear();
        let input: Vec<u16> = format!("^{key}$").encode_utf16().collect();
        let mut seen = HashSet::new();
        let mut max = 0u16;
        let mut visits = 0usize;
        for chars in input.windows(3) {
            let gram = (chars[0] as u32)
                .wrapping_mul(65599)
                .wrapping_add(chars[1] as u32)
                .wrapping_mul(65599)
                .wrapping_add(chars[2] as u32);
            if !seen.insert(gram) {
                continue;
            }
            let (mut lo, mut hi) = (0usize, self.g);
            while lo < hi {
                let m = (lo + hi) / 2;
                if u32_at(&self.b, self.grams + 4 * m) < gram {
                    lo = m + 1;
                } else {
                    hi = m;
                }
            }
            if lo == self.g || u32_at(&self.b, self.grams + 4 * lo) != gram {
                continue;
            }
            let from = u32_at(&self.b, self.po + 4 * lo) as usize;
            let to = u32_at(&self.b, self.po + 4 * (lo + 1)) as usize;
            for at in from..to {
                let id = u32_at(&self.b, self.posts + 4 * at) as usize;
                if self.counts[id] == 0 {
                    self.touched.push(id);
                }
                self.counts[id] = self.counts[id].saturating_add(1);
                max = max.max(self.counts[id]);
                visits += 1;
                if visits.is_multiple_of(128)
                    && (visits > 100_000
                        || (budget_us > 0 && started.elapsed() > Duration::from_micros(budget_us)))
                {
                    for &id in &self.touched {
                        self.counts[id] = 0;
                    }
                    return Err(SearchFail::Timeout { visits });
                }
            }
        }
        let mut ids = Vec::with_capacity(limit);
        for score in (1..=max).rev() {
            for &id in &self.touched {
                if self.counts[id] == score {
                    ids.push(id);
                    if ids.len() == limit {
                        break;
                    }
                }
            }
            if ids.len() == limit {
                break;
            }
        }
        for &id in &self.touched {
            self.counts[id] = 0;
        }
        Ok((ids, visits))
    }
}

#[derive(Debug)]
pub enum SearchFail {
    Timeout { visits: usize },
}

#[cfg(test)]
mod tests {
    use super::{build_packed, PackedIndex};
    use crate::record::NameRecord;

    #[test]
    fn packed_round_trip_keeps_name_kind_location_not_source() {
        let recs = vec![
            NameRecord::new("OutboxWorker", "class", "src/outbox/worker.rs", 12, 9, ""),
            NameRecord::new(
                "drain_queue",
                "method",
                "src/outbox/worker.rs",
                40,
                3,
                "OutboxWorker",
            ),
        ];
        let bytes = build_packed(&recs);
        assert!(
            !std::str::from_utf8(&bytes).unwrap_or("").contains("fn "),
            "no source lines"
        );
        let mut idx = PackedIndex::load_bytes(bytes).unwrap();
        assert_eq!(idx.len(), 2);
        assert!(idx.exact_name("OutboxWorker"));
        let (ids, _) = idx.retrieve("outbox worker", 96, 0).unwrap();
        assert!(!ids.is_empty());
        let e = idx.entry(ids[0]);
        assert_eq!(e.name, "OutboxWorker");
        assert_eq!(e.kind, "class");
        assert_eq!(e.file, "src/outbox/worker.rs");
        assert_eq!(e.line, 12);
    }
}

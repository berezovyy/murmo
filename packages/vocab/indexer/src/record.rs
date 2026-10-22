//! A name record: spelling, kind, location, refs, owner, source. Never source text.

use serde_json::{json, Value};

use crate::source::SOURCE_TAGS;

/// One extracted name. `file` is a posix path relative to the repo root.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NameRecord {
    pub name: String,
    pub kind: String,
    pub file: String,
    pub line: u32,
    pub refs: u32,
    pub owner: String,
    /// Bit set of `SOURCE_*`. Default tags.
    pub source: u8,
    /// Packed word key; empty means `word_key(name)`.
    pub key: String,
}

impl NameRecord {
    pub fn new(
        name: impl Into<String>,
        kind: impl Into<String>,
        file: impl Into<String>,
        line: u32,
        refs: u32,
        owner: impl Into<String>,
    ) -> Self {
        Self {
            name: name.into(),
            kind: kind.into(),
            file: file.into(),
            line,
            refs,
            owner: owner.into(),
            source: SOURCE_TAGS,
            key: String::new(),
        }
    }

    pub fn to_json(&self) -> Value {
        json!([
            self.name,
            self.kind,
            self.file,
            self.line,
            self.refs,
            self.owner,
            self.source,
            self.key
        ])
    }
}

pub fn record_from_json(v: &Value) -> Option<NameRecord> {
    let a = v.as_array()?;
    Some(NameRecord {
        name: a.first()?.as_str()?.to_string(),
        kind: a.get(1)?.as_str()?.to_string(),
        file: a.get(2)?.as_str()?.to_string(),
        line: a.get(3)?.as_u64()? as u32,
        refs: a.get(4)?.as_u64()? as u32,
        owner: a.get(5)?.as_str()?.to_string(),
        source: a
            .get(6)
            .and_then(Value::as_u64)
            .unwrap_or(SOURCE_TAGS as u64) as u8,
        key: a.get(7).and_then(Value::as_str).unwrap_or("").to_string(),
    })
}

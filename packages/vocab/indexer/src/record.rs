//! A name record: spelling, kind, location, refs, owner. Never source text.

use serde_json::{json, Value};

/// One extracted name. `file` is a posix path relative to the repo root.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NameRecord {
    pub name: String,
    pub kind: String,
    pub file: String,
    pub line: u32,
    pub refs: u32,
    pub owner: String,
}

impl NameRecord {
    pub fn to_json(&self) -> Value {
        json!([self.name, self.kind, self.file, self.line, self.refs, self.owner])
    }
}

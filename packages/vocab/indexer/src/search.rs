//! Native candidate search: ≤ 96 trigram hits, ≤ 300 µs, ≤ 256 UTF-16 units.

use serde_json::{json, Value};

use crate::packed::{PackedIndex, SearchFail};
use crate::split::word_key;

pub const NATIVE_CANDIDATES: usize = 96;
pub const NATIVE_BUDGET_US: u64 = 300;
pub const MAX_QUERY_UNITS: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SearchStatus {
    Ok,
    Exact,
    Invalid,
    Timeout,
    Unloaded,
}

pub struct SearchAnswer {
    pub status: SearchStatus,
    pub rows: Vec<Value>,
    pub ids: Vec<usize>,
    pub visits: usize,
}

impl SearchAnswer {
    pub fn to_json(&self) -> Value {
        let status = match self.status {
            SearchStatus::Ok => "ok",
            SearchStatus::Exact => "exact",
            SearchStatus::Invalid => "invalid",
            SearchStatus::Timeout => "timeout",
            SearchStatus::Unloaded => "unloaded",
        };
        json!({
            "status": status,
            "rows": self.rows,
            "ids": self.ids,
            "visits": self.visits,
        })
    }
}

fn empty(status: SearchStatus) -> SearchAnswer {
    SearchAnswer {
        status,
        rows: Vec::new(),
        ids: Vec::new(),
        visits: 0,
    }
}

/// Native retrieval. Ranking (tiers 0–3) stays in JS.
pub fn search(
    index: Option<&mut PackedIndex>,
    raw: &str,
    key: Option<&str>,
    limit: usize,
    budget_us: u64,
) -> SearchAnswer {
    let Some(index) = index else {
        return empty(SearchStatus::Unloaded);
    };
    let units = raw.encode_utf16().count();
    if units > MAX_QUERY_UNITS || units == 0 || limit == 0 || limit > NATIVE_CANDIDATES {
        return empty(SearchStatus::Invalid);
    }
    if index.exact_name(raw.trim_matches('`').trim_end_matches("()")) {
        return empty(SearchStatus::Exact);
    }
    let k = key.map(str::to_string).unwrap_or_else(|| word_key(raw));
    if k.encode_utf16().count() > MAX_QUERY_UNITS {
        return empty(SearchStatus::Invalid);
    }
    match index.retrieve(&k, limit, budget_us) {
        Err(SearchFail::Timeout { visits }) => SearchAnswer {
            status: SearchStatus::Timeout,
            rows: Vec::new(),
            ids: Vec::new(),
            visits,
        },
        Ok((ids, visits)) => {
            let rows = ids
                .iter()
                .map(|&id| {
                    let e = index.entry(id);
                    json!({
                        "id": id,
                        "name": e.name,
                        "key": e.key,
                        "refs": e.refs,
                        "locations": e.locations,
                        "member": e.member,
                        "location": { "kind": e.kind, "file": e.file, "line": e.line },
                    })
                })
                .collect();
            SearchAnswer {
                status: SearchStatus::Ok,
                rows,
                ids,
                visits,
            }
        }
    }
}

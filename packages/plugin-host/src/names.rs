//! Native names-v1 search on the supervisor (not in QuickJS). One loaded index
//! per helper; retrieval is offset-based, never a full scan (lesson 69).

use std::path::Path;
use std::sync::Mutex;

use murmo_indexer::packed::PackedIndex;
use murmo_indexer::search::{search, NATIVE_BUDGET_US, NATIVE_CANDIDATES};
use serde_json::{json, Value};

static INDEX: Mutex<Option<PackedIndex>> = Mutex::new(None);

pub fn is_names_op(op: &str) -> bool {
    matches!(op, "names.load" | "names.search" | "names.unload")
}

pub fn handle(q: &Value) -> Value {
    let op = q.get("op").and_then(Value::as_str).unwrap_or("");
    match op {
        "names.load" => load(q),
        "names.search" => search_op(q),
        "names.unload" => {
            *INDEX.lock().expect("names") = None;
            json!({"status": "ok"})
        }
        _ => json!({"status": "error", "kind": "transport", "error": "unknown names op"}),
    }
}

fn load(q: &Value) -> Value {
    let path = q.get("path").and_then(Value::as_str).unwrap_or("");
    if path.is_empty() {
        return json!({"status": "error", "kind": "transport", "error": "names.load needs path"});
    }
    match PackedIndex::load_path(Path::new(path)) {
        Ok(idx) => {
            let n = idx.len();
            let resident = idx.resident_bytes();
            *INDEX.lock().expect("names") = Some(idx);
            json!({"status": "ok", "records": n, "residentBytes": resident})
        }
        Err(e) => json!({"status": "error", "kind": "transport", "error": e}),
    }
}

fn search_op(q: &Value) -> Value {
    let raw = q.get("raw").and_then(Value::as_str).unwrap_or("");
    let key = q.get("key").and_then(Value::as_str);
    let limit = q
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(NATIVE_CANDIDATES as u64) as usize;
    let budget = q
        .get("budgetUs")
        .and_then(Value::as_u64)
        .unwrap_or(NATIVE_BUDGET_US);
    let mut guard = INDEX.lock().expect("names");
    search(guard.as_mut(), raw, key, limit, budget).to_json()
}

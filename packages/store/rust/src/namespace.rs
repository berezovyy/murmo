//! The draft 2.0-pre plugin storage rules (port of `src/plugin-namespace.ts`)
//! and the durable per-key merge under the namespace lock (port of
//! `src/node/plugin-storage.ts`). Messages match the JS backend word for word.

use serde_json::{json, Map, Value};

use crate::files::ModeRepairs;
use crate::layout::StoreLayout;
use crate::record::{read_record, update_record, Change, RecordRead, UpdateOptions, Updated};
use crate::records::RecordKind;

/// `LIMITS.storageBytes`, `storageKeys`, `storageKeyUnits` of `@murmo/api`.
pub const STORAGE_BYTES: usize = 65_536;
pub const STORAGE_KEYS: usize = 64;
pub const STORAGE_KEY_UNITS: usize = 128;
const RECORD_BYTES: u64 = STORAGE_BYTES as u64 + 1024;

pub const PRIVATE_MODE_REASON: &str = "private mode";

/// A `StorageResult` of `@murmo/api`, as JSON.
pub fn result(status: &str, reason: Option<&str>) -> Value {
    match reason {
        Some(r) => json!({ "status": status, "reason": r }),
        None => json!({ "status": status }),
    }
}

pub fn storage_key_problem(key: &str) -> Option<String> {
    if key.is_empty() {
        return Some("storage keys are non-empty strings".into());
    }
    if key.encode_utf16().count() > STORAGE_KEY_UNITS {
        return Some(format!(
            "storage keys are at most {STORAGE_KEY_UNITS} UTF-16 units"
        ));
    }
    None
}

pub fn quota_problem(data: &Map<String, Value>) -> Option<String> {
    if data.len() > STORAGE_KEYS {
        return Some(format!("plugin storage holds at most {STORAGE_KEYS} keys"));
    }
    // serde_json and JSON.stringify agree on strings, integers and objects;
    // a float may differ by a byte or two in exponent form.
    if serde_json::to_string(data)
        .map(|s| s.len())
        .unwrap_or(usize::MAX)
        > STORAGE_BYTES
    {
        return Some(format!(
            "plugin storage holds at most {STORAGE_BYTES} bytes of JSON"
        ));
    }
    None
}

fn data_of(record: Option<&Map<String, Value>>, plugin: &str) -> Map<String, Value> {
    match record {
        Some(r) if r.get("plugin").and_then(Value::as_str) == Some(plugin) => r
            .get("data")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default(),
        _ => Map::new(),
    }
}

fn revisions_of(record: Option<&Map<String, Value>>, plugin: &str) -> Map<String, Value> {
    match record {
        Some(r) if r.get("plugin").and_then(Value::as_str) == Some(plugin) => r
            .get("revisions")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default(),
        _ => Map::new(),
    }
}

fn revision_of(revisions: &Map<String, Value>, data: &Map<String, Value>, key: &str) -> u64 {
    if let Some(n) = revisions.get(key).and_then(Value::as_u64) {
        return n;
    }
    if data.contains_key(key) {
        1
    } else {
        0
    }
}

pub fn get(layout: &StoreLayout, plugin: &str, key: &str, repairs: &mut ModeRepairs) -> Value {
    // Same order as the JS backend: an unreadable namespace wins over a bad key.
    let record = match read_record(
        RecordKind::Plugin,
        &layout.plugin_record(plugin),
        RECORD_BYTES,
        repairs,
    ) {
        RecordRead::Unreadable(reason) => {
            return result("error", Some(&format!("storage {reason}")))
        }
        RecordRead::Missing => None,
        RecordRead::Ok(r) => Some(r),
    };
    let data = data_of(record.as_ref(), plugin);
    let revisions = revisions_of(record.as_ref(), plugin);
    if let Some(problem) = storage_key_problem(key) {
        return result("denied", Some(&problem));
    }
    let revision = revision_of(&revisions, &data, key);
    match data.get(key) {
        Some(value) => json!({ "status": "ok", "value": value, "revision": revision }),
        None => json!({ "status": "ok", "revision": 0 }),
    }
}

/// `Some(value)`: set the key; `None`: delete it. `expected` is compare-and-set.
pub fn change(
    layout: &StoreLayout,
    private: bool,
    plugin: &str,
    key: &str,
    value: Option<Value>,
    expected: Option<u64>,
    repairs: &mut ModeRepairs,
) -> Value {
    if private {
        return result("denied", Some(PRIVATE_MODE_REASON));
    }
    if let Some(problem) = storage_key_problem(key) {
        return result("denied", Some(&problem));
    }
    let options = UpdateOptions {
        max_bytes: RECORD_BYTES,
        ..UpdateOptions::new(&layout.roots.data)
    };
    let outcome = update_record(
        RecordKind::Plugin,
        &layout.plugin_record(plugin),
        &options,
        repairs,
        |current| {
            let mut data = data_of(current.as_ref(), plugin);
            let mut revisions = revisions_of(current.as_ref(), plugin);
            let current_rev = revision_of(&revisions, &data, key);
            if let Some(want) = expected {
                if current_rev != want {
                    return Change::Unchanged(json!({
                        "status": "conflict",
                        "revision": current_rev,
                        "reason": "revision mismatch"
                    }));
                }
            }
            match value {
                None => {
                    if data.remove(key).is_none() {
                        return Change::Unchanged(json!({ "status": "ok", "revision": 0 }));
                    }
                    revisions.remove(key);
                    let mut record = Map::new();
                    record.insert("schema".into(), json!(1));
                    record.insert("plugin".into(), json!(plugin));
                    record.insert("data".into(), Value::Object(data));
                    record.insert("revisions".into(), Value::Object(revisions));
                    Change::Write(record, json!({ "status": "ok", "revision": 0 }))
                }
                Some(v) => {
                    data.insert(key.to_string(), v);
                    if let Some(quota) = quota_problem(&data) {
                        return Change::Unchanged(result("quota", Some(&quota)));
                    }
                    let revision = current_rev + 1;
                    revisions.insert(key.to_string(), json!(revision));
                    let mut record = Map::new();
                    record.insert("schema".into(), json!(1));
                    record.insert("plugin".into(), json!(plugin));
                    record.insert("data".into(), Value::Object(data));
                    record.insert("revisions".into(), Value::Object(revisions));
                    Change::Write(record, json!({ "status": "ok", "revision": revision }))
                }
            }
        },
    );
    match outcome {
        Updated::Ok { result, .. } => result,
        Updated::Busy => result("error", Some("storage is busy; try again")),
        Updated::Error(reason) => result("error", Some(&reason)),
    }
}

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

fn data_of(record: Option<Map<String, Value>>, plugin: &str) -> Map<String, Value> {
    match record {
        Some(r) if r.get("plugin").and_then(Value::as_str) == Some(plugin) => r
            .get("data")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default(),
        _ => Map::new(),
    }
}

pub fn get(layout: &StoreLayout, plugin: &str, key: &str, repairs: &mut ModeRepairs) -> Value {
    // Same order as the JS backend: an unreadable namespace wins over a bad key.
    let data = match read_record(
        RecordKind::Plugin,
        &layout.plugin_record(plugin),
        RECORD_BYTES,
        repairs,
    ) {
        RecordRead::Unreadable(reason) => {
            return result("error", Some(&format!("storage {reason}")))
        }
        RecordRead::Missing => Map::new(),
        RecordRead::Ok(r) => data_of(Some(r), plugin),
    };
    if let Some(problem) = storage_key_problem(key) {
        return result("denied", Some(&problem));
    }
    match data.get(key) {
        Some(value) => json!({ "status": "ok", "value": value }),
        None => result("ok", None),
    }
}

/// `Some(value)`: set the key; `None`: delete it.
pub fn change(
    layout: &StoreLayout,
    private: bool,
    plugin: &str,
    key: &str,
    value: Option<Value>,
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
            let mut data = data_of(current, plugin);
            match value {
                None => {
                    if data.remove(key).is_none() {
                        return Change::Unchanged(result("ok", None));
                    }
                }
                Some(v) => {
                    data.insert(key.to_string(), v);
                    if let Some(quota) = quota_problem(&data) {
                        return Change::Unchanged(result("quota", Some(&quota)));
                    }
                }
            }
            let mut record = Map::new();
            record.insert("schema".into(), json!(1));
            record.insert("plugin".into(), json!(plugin));
            record.insert("data".into(), Value::Object(data));
            Change::Write(record, result("ok", None))
        },
    );
    match outcome {
        Updated::Ok { result, .. } => result,
        Updated::Busy => result("error", Some("storage is busy; try again")),
        Updated::Error(reason) => result("error", Some(&reason)),
    }
}

//! Record shapes (port of `src/records.ts`): one JSON document
//! `{"schema":1,…}`, at most 1 MiB. Every reader checks the shape, so a
//! hand-edited or foreign file is treated as unreadable, never trusted.

use serde_json::{Map, Value};

pub const RECORD_SCHEMA: u64 = 1;
pub const RECORD_MAX_BYTES: u64 = 1_048_576;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecordKind {
    Trust,
    Words,
    Plugin,
    Meta,
    Private,
    Pointer,
}

impl RecordKind {
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "trust" => RecordKind::Trust,
            "words" => RecordKind::Words,
            "plugin" => RecordKind::Plugin,
            "meta" => RecordKind::Meta,
            "private" => RecordKind::Private,
            "pointer" => RecordKind::Pointer,
            _ => return None,
        })
    }

    pub fn name(self) -> &'static str {
        match self {
            RecordKind::Trust => "trust",
            RecordKind::Words => "words",
            RecordKind::Plugin => "plugin",
            RecordKind::Meta => "meta",
            RecordKind::Private => "private",
            RecordKind::Pointer => "pointer",
        }
    }
}

fn hex_of(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn decimal(value: &str) -> bool {
    value == "0"
        || (!value.is_empty()
            && !value.starts_with('0')
            && value.bytes().all(|b| b.is_ascii_digit()))
}

/// JS `Number.isSafeInteger(v) && v >= 0`.
fn count(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Number(n)) => match (n.as_u64(), n.as_f64()) {
            (Some(u), _) => u < 1u64 << 53,
            (None, Some(f)) => f >= 0.0 && f.fract() == 0.0 && f <= ((1u64 << 53) - 1) as f64,
            _ => false,
        },
        _ => false,
    }
}

fn string<'a>(v: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn approval(id: &str, value: &Value) -> bool {
    let Some(v) = value.as_object() else {
        return false;
    };
    string(v, "projectId") == Some(id)
        && hex_of(id, 64)
        && string(v, "root").is_some()
        && string(v, "dev").is_some_and(decimal)
        && string(v, "ino").is_some_and(decimal)
        && string(v, "fingerprint").is_some_and(|f| hex_of(f, 64))
        && count(v.get("approvedAt"))
        && count(v.get("shortcutCount"))
}

fn snapshot_dir(value: &str) -> bool {
    value
        .strip_prefix("snap-")
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

fn file_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
}

fn check(kind: RecordKind, v: &Map<String, Value>) -> bool {
    match kind {
        RecordKind::Trust => v
            .get("approvals")
            .and_then(Value::as_object)
            .is_some_and(|a| a.iter().all(|(id, x)| approval(id, x))),
        RecordKind::Words => v
            .get("words")
            .and_then(Value::as_array)
            .is_some_and(|w| w.iter().all(Value::is_string)),
        RecordKind::Plugin => {
            string(v, "plugin").is_some() && v.get("data").is_some_and(Value::is_object)
        }
        RecordKind::Meta => {
            string(v, "epoch").is_some_and(|e| hex_of(e, 32)) && count(v.get("generation"))
        }
        RecordKind::Private => count(v.get("since")),
        RecordKind::Pointer => {
            let generation_ok = count(v.get("generation"));
            let dir_ok = match (
                v.get("generation").and_then(Value::as_u64),
                string(v, "directory"),
            ) {
                (Some(g), Some(d)) => d == format!("snap-{g}"),
                _ => false,
            };
            let previous_ok = match v.get("previous") {
                None => true,
                Some(Value::String(p)) => snapshot_dir(p),
                Some(_) => false,
            };
            let files_ok = v
                .get("files")
                .and_then(Value::as_object)
                .is_some_and(|files| {
                    files.iter().all(|(name, f)| {
                        file_name(name)
                            && f.as_object().is_some_and(|f| {
                                count(f.get("bytes"))
                                    && string(f, "sha256").is_some_and(|h| hex_of(h, 64))
                            })
                    })
                });
            generation_ok && dir_ok && previous_ok && files_ok
        }
    }
}

/// The record in `text`, or None when it isn't one of this kind and schema.
pub fn decode_record(kind: RecordKind, text: &str) -> Option<Map<String, Value>> {
    let Ok(Value::Object(v)) = serde_json::from_str::<Value>(text) else {
        return None;
    };
    let schema_ok = matches!(v.get("schema"), Some(Value::Number(n)) if n.as_u64() == Some(RECORD_SCHEMA) || n.as_f64() == Some(1.0));
    (schema_ok && check(kind, &v)).then_some(v)
}

/// Compact JSON with a trailing newline.
pub fn encode_record(record: &Map<String, Value>) -> String {
    let mut text = serde_json::to_string(record).unwrap_or_else(|_| "{}".into());
    text.push('\n');
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn foreign_and_hand_edited_records_are_refused() {
        // A record from another program, or a trust approval whose ID doesn't
        // match its key, must never be trusted.
        assert!(decode_record(RecordKind::Words, r#"{"schema":1,"words":["a"]}"#).is_some());
        assert!(decode_record(RecordKind::Words, r#"{"schema":2,"words":["a"]}"#).is_none());
        assert!(decode_record(RecordKind::Words, r#"{"schema":1,"words":[1]}"#).is_none());
        let id = "a".repeat(64);
        let other = "b".repeat(64);
        let good = format!(
            r#"{{"schema":1,"approvals":{{"{id}":{{"projectId":"{id}","root":"/r","dev":"1","ino":"2","fingerprint":"{id}","approvedAt":1,"shortcutCount":0}}}}}}"#
        );
        assert!(decode_record(RecordKind::Trust, &good).is_some());
        assert!(decode_record(
            RecordKind::Trust,
            &good.replacen(&format!("\"{id}\":"), &format!("\"{other}\":"), 1)
        )
        .is_none());
        assert!(decode_record(
            RecordKind::Meta,
            r#"{"schema":1,"epoch":"00","generation":1}"#
        )
        .is_none());
    }
}

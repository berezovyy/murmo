//! The helper side of the store protocol (`packages/store/src/protocol.ts`):
//! one JSON request, one JSON reply, the same replies as the Node reference
//! handler (`src/node/server.ts`).

use std::collections::HashMap;
use std::path::Path;

use serde_json::{json, Map, Value};

use crate::drafts::{DraftDocument, DraftSave, DraftWrite, Drafts};
use crate::files::{remove_stale_temps, ModeRepairs};
use crate::layout::{check_project_id, StoreLayout, StoreRoots, LOG_KINDS};
use crate::logs::LogWriter;
use crate::namespace::{self, result, PRIVATE_MODE_REASON};
use crate::record::{read_record, update_record, Change, RecordRead, UpdateOptions, Updated};
use crate::records::{RecordKind, RECORD_MAX_BYTES};

pub struct Store {
    pub layout: StoreLayout,
    /// `[privacy] private` of the merged config; the flag file counts too.
    pub config_private: bool,
    pub repairs: ModeRepairs,
    writers: HashMap<(String, String), LogWriter>,
    /// Draft rescue files, and the session locks this process holds for its clients.
    drafts: Drafts,
}

/// JavaScript's `\s` plus U+0085: the set `src/node/store.ts` uses.
fn js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{85}' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn invisible(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}'
        | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}')
}

/// Same checks and messages as `wordProblem` in `src/node/store.ts`.
pub fn word_problem(word: &str) -> Option<&'static str> {
    if word.is_empty() {
        return Some("a word is a non-empty string");
    }
    if word.chars().count() > 64 {
        return Some("a word is at most 64 characters");
    }
    if word.chars().any(js_whitespace) {
        return Some("a word has no whitespace");
    }
    if word.chars().any(invisible) {
        return Some("a word has no control or invisible characters");
    }
    None
}

fn is_entry_line(line: &str) -> bool {
    !line.contains('\n')
        && !line.contains('\r')
        && matches!(serde_json::from_str::<Value>(line), Ok(Value::Object(_)))
}

fn str_field<'a>(r: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    r.get(key).and_then(Value::as_str)
}

/// An optional field: absent, or of its type (`null` is neither), as `parseStoreRequest` reads it.
fn optional<'a, T>(
    r: &'a Map<String, Value>,
    key: &str,
    get: impl Fn(&'a Value) -> Option<T>,
) -> Option<Option<T>> {
    match r.get(key) {
        None => Some(None),
        Some(v) => get(v).map(Some),
    }
}

/// A draft identity on the wire (`draft`, since the helper stamps every
/// request with its numeric `id`): three strings; the store checks them.
fn draft_id(r: &Map<String, Value>) -> Option<(&str, &str, &str)> {
    let id = r.get("draft")?.as_object()?;
    Some((
        str_field(id, "project")?,
        str_field(id, "host")?,
        str_field(id, "session")?,
    ))
}

fn document_reply(document: Option<DraftDocument>) -> Value {
    match document {
        Some(d) => json!({ "status": "ok", "value": d.to_value() }),
        None => result("ok", None),
    }
}

/// A thrown error of the JS backend becomes `{status:"error", reason}` there too.
fn replied(outcome: Result<Value, String>) -> Value {
    outcome.unwrap_or_else(|reason| result("error", Some(&reason)))
}

impl Store {
    /// Opens the store; stale temps of killed writers are removed.
    pub fn open(roots: StoreRoots, config_private: bool) -> Self {
        let layout = StoreLayout::new(roots);
        for dir in [&layout.store, &layout.plugins] {
            let _ = remove_stale_temps(dir);
        }
        for kind in LOG_KINDS {
            if let Some(dir) = layout.log_directory(kind) {
                let _ = remove_stale_temps(&dir);
            }
        }
        Store {
            layout,
            config_private,
            repairs: ModeRepairs::default(),
            writers: HashMap::new(),
            drafts: Drafts::default(),
        }
    }

    pub fn is_private(&self) -> bool {
        self.config_private || std::fs::symlink_metadata(&self.layout.private_flag).is_ok()
    }

    /// Answers one request.
    pub fn handle(&mut self, message: &Value) -> Value {
        let malformed = || result("error", Some("malformed store request"));
        let Some(r) = message.as_object() else {
            return malformed();
        };
        match str_field(r, "op") {
            Some(op @ ("storage.get" | "storage.delete" | "storage.set")) => {
                let (Some(plugin), Some(key)) = (str_field(r, "plugin"), str_field(r, "key"))
                else {
                    return malformed();
                };
                match op {
                    "storage.get" => namespace::get(&self.layout, plugin, key, &mut self.repairs),
                    "storage.delete" => {
                        let private = self.is_private();
                        namespace::change(
                            &self.layout,
                            private,
                            plugin,
                            key,
                            None,
                            None,
                            &mut self.repairs,
                        )
                    }
                    _ => {
                        let Some(value) = r.get("value") else {
                            return malformed();
                        };
                        let expected = r.get("expected").and_then(Value::as_u64);
                        let private = self.is_private();
                        namespace::change(
                            &self.layout,
                            private,
                            plugin,
                            key,
                            Some(value.clone()),
                            expected,
                            &mut self.repairs,
                        )
                    }
                }
            }
            Some("private.get") => json!({ "status": "ok", "value": self.is_private() }),
            Some("generation.get") => {
                let value = match read_record(
                    RecordKind::Meta,
                    &self.layout.meta,
                    RECORD_MAX_BYTES,
                    &mut self.repairs,
                ) {
                    RecordRead::Ok(m) => {
                        json!({ "epoch": m["epoch"], "generation": m["generation"] })
                    }
                    _ => json!({ "epoch": "none", "generation": 0 }),
                };
                json!({ "status": "ok", "value": value })
            }
            Some("words.add") => {
                let (Some(word), Some(learned)) = (
                    str_field(r, "word"),
                    r.get("learned").and_then(Value::as_bool),
                ) else {
                    return malformed();
                };
                let project = match r.get("projectId") {
                    None => None,
                    Some(Value::String(p)) => Some(p.as_str()),
                    Some(_) => return malformed(),
                };
                self.add_word(word, learned, project)
            }
            Some("log.append") => {
                let kind = str_field(r, "kind").filter(|k| LOG_KINDS.contains(k));
                let lines = r.get("lines").and_then(Value::as_array).and_then(|l| {
                    l.iter()
                        .map(|x| x.as_str().map(str::to_string))
                        .collect::<Option<Vec<_>>>()
                });
                let (Some(kind), Some(session), Some(lines)) =
                    (kind, str_field(r, "session"), lines)
                else {
                    return malformed();
                };
                self.append_log(kind, session, &lines)
            }
            Some("project.id") => match str_field(r, "cwd") {
                Some(cwd) => project_id_reply(cwd),
                None => malformed(),
            },
            Some(op) if op.starts_with("drafts.") => {
                self.handle_draft(op, r).unwrap_or_else(malformed)
            }
            _ => malformed(),
        }
    }

    /// The draft ops; None when the request is malformed.
    fn handle_draft(&mut self, op: &str, r: &Map<String, Value>) -> Option<Value> {
        let private = self.is_private();
        let layout = &self.layout;
        let repairs = &mut self.repairs;
        // Only the ops that take `now` read it, as `parseStoreRequest` does.
        let now = match op {
            "drafts.save" | "drafts.markAttempted" | "drafts.offer" | "drafts.cleanup" => {
                optional(r, "now", Value::as_f64)?
            }
            _ => None,
        };
        Some(match op {
            "drafts.save" => {
                let id = draft_id(r)?;
                let write = DraftWrite {
                    text: str_field(r, "text")?,
                    cursor_utf16: r.get("cursorUTF16")?.as_f64()?,
                    revision: r.get("revision")?.as_f64()?,
                    now,
                    attempted: optional(r, "attempted", Value::as_bool)? == Some(true),
                };
                replied(
                    self.drafts.save(layout, repairs, private, id, &write).map(
                        |saved| match saved {
                            DraftSave::Ok => result("ok", None),
                            DraftSave::Denied(reason) => result("denied", Some(reason)),
                            DraftSave::Error(reason) => result("error", Some(&reason)),
                        },
                    ),
                )
            }
            "drafts.read" => {
                let id = draft_id(r)?;
                replied(self.drafts.read(layout, repairs, id).map(document_reply))
            }
            "drafts.delete" => {
                let id = draft_id(r)?;
                replied(self.drafts.delete(layout, id).map(|()| result("ok", None)))
            }
            "drafts.markAttempted" => {
                let id = draft_id(r)?;
                replied(
                    self.drafts
                        .mark_attempted(layout, repairs, id, now)
                        .map(|()| result("ok", None)),
                )
            }
            "drafts.lock" => {
                let id = draft_id(r)?;
                replied(
                    self.drafts
                        .hold_lock(layout, repairs, id)
                        .map(|()| result("ok", None)),
                )
            }
            "drafts.unlock" => {
                let id = draft_id(r)?;
                replied(
                    self.drafts
                        .release_lock(layout, id)
                        .map(|()| result("ok", None)),
                )
            }
            "drafts.offer" => {
                let (project, host) = (str_field(r, "project")?, str_field(r, "host")?);
                let session = optional(r, "session", Value::as_str)?;
                replied(
                    self.drafts
                        .find_offerable(layout, repairs, project, host, session, now)
                        .map(document_reply),
                )
            }
            "drafts.cleanup" => replied(
                self.drafts
                    .cleanup(layout, repairs, now)
                    .map(|removed| json!({ "status": "ok", "value": { "removed": removed } })),
            ),
            _ => return None,
        })
    }

    fn add_word(&mut self, word: &str, learned: bool, project: Option<&str>) -> Value {
        if let Some(problem) = word_problem(word) {
            return result("denied", Some(problem));
        }
        if learned && self.is_private() {
            return result("denied", Some(PRIVATE_MODE_REASON));
        }
        let path = match project {
            None => self.layout.words.clone(),
            Some(id) if check_project_id(id) => self.layout.projects.join(id).join("words.json"),
            Some(_) => return result("error", Some("project id must be 64 lowercase hex digits")),
        };
        let options = UpdateOptions {
            durable: true,
            ..UpdateOptions::new(&self.layout.roots.data)
        };
        let outcome = update_record(
            RecordKind::Words,
            &path,
            &options,
            &mut self.repairs,
            |current| {
                let mut words: Vec<Value> = current
                    .and_then(|r| r.get("words").and_then(Value::as_array).cloned())
                    .unwrap_or_default();
                if words.iter().any(|w| w.as_str() == Some(word)) {
                    return Change::Unchanged(());
                }
                words.push(json!(word));
                let mut record = Map::new();
                record.insert("schema".into(), json!(1));
                record.insert("words".into(), Value::Array(words));
                Change::Write(record, ())
            },
        );
        match outcome {
            Updated::Ok { .. } => result("ok", None),
            Updated::Busy => result("busy", Some("store is busy; try again")),
            Updated::Error(reason) => result("error", Some(&reason)),
        }
    }

    fn append_log(&mut self, kind: &str, session: &str, lines: &[String]) -> Value {
        if !lines.iter().all(|l| is_entry_line(l)) {
            return result("error", Some("log lines must be JSON objects"));
        }
        let key = (kind.to_string(), session.to_string());
        if !self.writers.contains_key(&key) {
            match LogWriter::new(&self.layout, kind, session) {
                Ok(w) => {
                    self.writers.insert(key.clone(), w);
                }
                Err(e) => return result("error", Some(&e.to_string())),
            }
        }
        if self.is_private() {
            return result("denied", Some(PRIVATE_MODE_REASON));
        }
        // Re-serialized like the Node handler does: one compact object per line.
        let lines: Vec<String> = lines
            .iter()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .map(|v| v.to_string())
            .collect();
        let Some(writer) = self.writers.get_mut(&key) else {
            return result("error", Some("no log writer"));
        };
        match writer.append_lines(&lines, &mut self.repairs) {
            Ok(_) => result("ok", None),
            Err(e) => result("error", Some(&e.to_string())),
        }
    }
}

/// `project.id`: the project a session in `cwd` belongs to.
fn project_id_reply(cwd: &str) -> Value {
    let cwd = Path::new(cwd);
    if !cwd.is_absolute() {
        return result("error", Some("cwd must be an absolute path"));
    }
    match crate::identity::project_id_of_cwd(cwd) {
        Ok(id) => json!({ "status": "ok", "value": id }),
        Err(_) => result(
            "error",
            Some("cannot resolve the project of this directory"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_with_invisible_characters_are_refused() {
        // A zero-width or bidi character would make an allowlist entry that
        // looks like a different word in every listing.
        assert_eq!(word_problem("ok"), None);
        assert!(word_problem("a\u{200b}b").is_some());
        assert!(word_problem("a\u{202e}b").is_some());
        assert!(word_problem("a\u{85}b").is_some());
        assert!(word_problem(&"x".repeat(65)).is_some());
    }
}

//! `{ file = "…" }` expansions (port of `src/references.ts`).

use std::collections::{BTreeSet, HashMap};

use serde_json::{json, Value as Json};

use crate::diagnostics::{sort_diagnostics, Diagnostic, Severity};
use crate::schema::{expansion_problem, ConfigFile, Origin, ShortcutEntry, ShortcutMeta};

/// Why a reference was not loaded; the same codes and words as JS.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReferenceProblem {
    Absolute,
    Traversal,
    Escapes,
    NotFound,
    NotRegular,
    TooLarge,
    InvalidUtf8,
    Changed,
    Budget,
    Unreadable,
}

impl ReferenceProblem {
    pub fn code(self) -> &'static str {
        match self {
            ReferenceProblem::Absolute => "absolute",
            ReferenceProblem::Traversal => "traversal",
            ReferenceProblem::Escapes => "escapes",
            ReferenceProblem::NotFound => "not-found",
            ReferenceProblem::NotRegular => "not-regular",
            ReferenceProblem::TooLarge => "too-large",
            ReferenceProblem::InvalidUtf8 => "invalid-utf8",
            ReferenceProblem::Changed => "changed",
            ReferenceProblem::Budget => "budget",
            ReferenceProblem::Unreadable => "unreadable",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            ReferenceProblem::Absolute => "is an absolute path",
            ReferenceProblem::Traversal => "must be a relative path without \"..\" or \"\\\"",
            ReferenceProblem::Escapes => "resolves outside the repository",
            ReferenceProblem::NotFound => "does not exist",
            ReferenceProblem::NotRegular => "is not a regular file",
            ReferenceProblem::TooLarge => "is larger than 16 KiB",
            ReferenceProblem::InvalidUtf8 => "is not UTF-8 text",
            ReferenceProblem::Changed => "changed while it was read",
            ReferenceProblem::Budget => "is past the 1 MiB or 128-file read budget of one load",
            ReferenceProblem::Unreadable => "could not be read",
        }
    }
}

pub enum ReferenceRead {
    Ok(String),
    Refused(ReferenceProblem),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Shortcut {
    pub shortcut: String,
    pub text: String,
    pub origin: Origin,
    pub reference: Option<String>,
    pub meta: ShortcutMeta,
}

impl Shortcut {
    pub fn to_json(&self) -> Json {
        let mut v =
            json!({ "shortcut": self.shortcut, "text": self.text, "origin": self.origin.name() });
        if let Some(r) = &self.reference {
            v["reference"] = json!(r);
        }
        self.meta.to_json_fields(&mut v);
        v
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct LoadedConfig {
    pub config: ConfigFile,
    /// Usable expansions, sorted by shortcut.
    pub replacements: Vec<Shortcut>,
}

impl LoadedConfig {
    pub fn to_json(&self) -> Json {
        let mut v = self.config.to_json();
        v["replacements"] = Json::Array(self.replacements.iter().map(Shortcut::to_json).collect());
        v
    }
}

/// Every `file` path the config refers to, once each, sorted.
pub fn referenced_paths(config: &ConfigFile) -> Vec<String> {
    let set: BTreeSet<&str> = config
        .shortcuts
        .iter()
        .filter_map(|e| match e {
            ShortcutEntry::File { path, .. } => Some(path.as_str()),
            ShortcutEntry::Text { .. } => None,
        })
        .collect();
    set.into_iter().map(str::to_string).collect()
}

/// Exactly one trailing LF or CRLF is dropped.
pub fn drop_one_newline(text: &str) -> &str {
    text.strip_suffix("\r\n")
        .or_else(|| text.strip_suffix('\n'))
        .unwrap_or(text)
}

pub fn resolve_shortcuts(
    config: ConfigFile,
    reads: &HashMap<String, ReferenceRead>,
) -> LoadedConfig {
    let mut replacements = Vec::new();
    let mut diagnostics = config.diagnostics.clone();
    for entry in &config.shortcuts {
        match entry {
            ShortcutEntry::Text {
                shortcut,
                text,
                meta,
                ..
            } => replacements.push(Shortcut {
                shortcut: shortcut.clone(),
                text: text.clone(),
                origin: config.origin,
                reference: None,
                meta: meta.clone(),
            }),
            ShortcutEntry::File {
                shortcut,
                path,
                at,
                meta,
            } => {
                let skip = |code, message: String| {
                    Diagnostic::new(Severity::Warning, code, &config.file, *at, &message, None)
                };
                match reads
                    .get(path)
                    .unwrap_or(&ReferenceRead::Refused(ReferenceProblem::Unreadable))
                {
                    ReferenceRead::Refused(problem) => diagnostics.push(skip(
                        "invalid-reference",
                        format!(
                            "file \"{path}\" of \"{shortcut}\" {}; skipped",
                            problem.message()
                        ),
                    )),
                    ReferenceRead::Ok(raw) => {
                        let text = drop_one_newline(raw);
                        match expansion_problem(text) {
                            Some((code, message)) => {
                                diagnostics.push(skip(
                                    code,
                                    format!("file \"{path}\" of \"{shortcut}\" {message}; skipped"),
                                ));
                            }
                            None => replacements.push(Shortcut {
                                shortcut: shortcut.clone(),
                                text: text.to_string(),
                                origin: config.origin,
                                reference: Some(path.clone()),
                                meta: meta.clone(),
                            }),
                        }
                    }
                }
            }
        }
    }
    sort_diagnostics(&mut diagnostics);
    LoadedConfig {
        config: ConfigFile {
            diagnostics,
            ..config
        },
        replacements,
    }
}

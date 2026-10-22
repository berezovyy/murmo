//! Schema v1 (port of `src/schema.ts`): limits, types and per-entry failures,
//! with the same messages in the same order.

use std::collections::BTreeMap;

use serde_json::{json, Map, Number, Value as Json};
use toml::Value;

use crate::diagnostics::{sort_diagnostics, Diagnostic, Position, Severity, FILE_START};
use crate::limits::{
    CONFIG_FILE_BYTES, EXPANSION_BYTES, SHORTCUTS_PER_FILE, SHORTCUT_CODE_POINTS, WORD_CODE_POINTS,
};
use crate::source::{
    code_point_length, excerpt_at, normalize_toml, parser_position, scan_source, Locator,
};
use crate::text_policy::unsafe_text;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    User,
    Project,
}

impl Origin {
    pub fn name(self) -> &'static str {
        match self {
            Origin::User => "user",
            Origin::Project => "project",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum ShortcutEntry {
    Text {
        shortcut: String,
        text: String,
        at: Position,
    },
    File {
        shortcut: String,
        path: String,
        at: Position,
    },
}

impl ShortcutEntry {
    pub fn shortcut(&self) -> &str {
        match self {
            ShortcutEntry::Text { shortcut, .. } | ShortcutEntry::File { shortcut, .. } => shortcut,
        }
    }

    pub fn at(&self) -> Position {
        match self {
            ShortcutEntry::Text { at, .. } | ShortcutEntry::File { at, .. } => *at,
        }
    }

    pub fn to_json(&self) -> Json {
        match self {
            ShortcutEntry::Text { shortcut, text, at } => {
                json!({ "kind": "text", "shortcut": shortcut, "text": text, "at": at.to_json() })
            }
            ShortcutEntry::File { shortcut, path, at } => {
                json!({ "kind": "file", "shortcut": shortcut, "path": path, "at": at.to_json() })
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PluginTable {
    /// Host-owned; never passed to the plugin.
    pub enabled: Option<bool>,
    pub settings: Map<String, Json>,
    pub at: Position,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ConfigFile {
    pub file: String,
    pub origin: Origin,
    /// False: the whole file is ignored.
    pub ok: bool,
    pub language: Option<String>,
    pub shortcuts: Vec<ShortcutEntry>,
    pub protect: Vec<String>,
    pub autocorrect: Option<bool>,
    pub names: Option<NamesSettings>,
    pub phrases_learn: Option<bool>,
    pub history_enabled: Option<bool>,
    pub plugin_order: Option<Vec<String>>,
    pub plugins: BTreeMap<String, PluginTable>,
    pub private: Option<bool>,
    pub events: Option<bool>,
    pub events_fail_open: Option<bool>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NamesSettings {
    pub enabled: Option<bool>,
    pub key: Option<String>,
    pub languages: Option<Vec<String>>,
    pub max_file_bytes: Option<u64>,
}

impl NamesSettings {
    pub fn to_json(&self) -> Json {
        let mut v = Map::new();
        if let Some(e) = self.enabled {
            v.insert("enabled".into(), Json::Bool(e));
        }
        if let Some(k) = &self.key {
            v.insert("key".into(), Json::String(k.clone()));
        }
        if let Some(l) = &self.languages {
            v.insert("languages".into(), json!(l));
        }
        if let Some(n) = self.max_file_bytes {
            v.insert("maxFileBytes".into(), json!(n));
        }
        Json::Object(v)
    }
}

impl ConfigFile {
    /// The same JSON as the JS `ConfigFile`.
    pub fn to_json(&self) -> Json {
        let mut plugins = Map::new();
        for (id, t) in &self.plugins {
            let mut v = json!({ "settings": t.settings, "at": t.at.to_json() });
            if let Some(e) = t.enabled {
                v["enabled"] = json!(e);
            }
            plugins.insert(id.clone(), v);
        }
        let mut v = json!({
            "file": self.file,
            "origin": self.origin.name(),
            "status": if self.ok { "ok" } else { "ignored" },
            "shortcuts": self.shortcuts.iter().map(ShortcutEntry::to_json).collect::<Vec<_>>(),
            "protect": self.protect,
            "plugins": plugins,
            "diagnostics": self.diagnostics.iter().map(Diagnostic::to_json).collect::<Vec<_>>(),
        });
        if let Some(l) = &self.language {
            v["language"] = json!(l);
        }
        if let Some(a) = self.autocorrect {
            v["autocorrect"] = json!(a);
        }
        if let Some(n) = &self.names {
            v["names"] = n.to_json();
        }
        if let Some(p) = self.phrases_learn {
            v["phrasesLearn"] = json!(p);
        }
        if let Some(h) = self.history_enabled {
            v["historyEnabled"] = json!(h);
        }
        if let Some(o) = &self.plugin_order {
            v["pluginOrder"] = json!(o);
        }
        if let Some(p) = self.private {
            v["private"] = json!(p);
        }
        if let Some(e) = self.events {
            v["events"] = json!(e);
        }
        if let Some(f) = self.events_fail_open {
            v["eventsFailOpen"] = json!(f);
        }
        v
    }
}

/// A file the loader could not hand to the parser at all.
pub fn ignored_file(
    file: &str,
    origin: Origin,
    code: &'static str,
    message: &str,
    at: Position,
    excerpt: Option<&str>,
) -> ConfigFile {
    ConfigFile {
        file: file.to_string(),
        origin,
        ok: false,
        language: None,
        shortcuts: Vec::new(),
        protect: Vec::new(),
        autocorrect: None,
        names: None,
        phrases_learn: None,
        history_enabled: None,
        plugin_order: None,
        plugins: BTreeMap::new(),
        private: None,
        events: None,
        events_fail_open: None,
        diagnostics: vec![Diagnostic::new(
            Severity::Error,
            code,
            file,
            at,
            message,
            excerpt,
        )],
    }
}

/// `^[a-z0-9]` then `[a-z0-9-]*`.
fn id_part(s: &str, max: usize) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= max
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// The manifest `name` rule of `@murmo/api`.
pub fn plugin_id(s: &str) -> bool {
    match s.strip_prefix('@') {
        Some(rest) => match rest.split_once('/') {
            Some((scope, name)) => id_part(scope, usize::MAX) && id_part(name, 64),
            None => false,
        },
        None => id_part(s, 64),
    }
}

/// `^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$`.
fn language_tag(s: &str) -> bool {
    let mut parts = s.split('-');
    let first = parts.next().unwrap_or("");
    (2..=3).contains(&first.len())
        && first.bytes().all(|c| c.is_ascii_lowercase())
        && parts.all(|p| (2..=8).contains(&p.len()) && p.bytes().all(|c| c.is_ascii_alphanumeric()))
}

fn shortcut_first(c: char) -> bool {
    c.is_alphabetic() || c.is_numeric() || matches!(c, ';' | ',' | '\\' | '=' | '+')
}

/// JavaScript's `\s` plus U+0085: the explicit set of `src/schema.ts`.
pub fn whitespace(c: char) -> bool {
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

pub fn shortcut_problem(key: &str) -> Option<&'static str> {
    if unsafe_text(key).is_some() {
        return Some("contains a control or bidirectional character");
    }
    let Some(first) = key.chars().next() else {
        return Some("is empty");
    };
    if code_point_length(key) > SHORTCUT_CODE_POINTS {
        return Some("is longer than 32 characters");
    }
    if !shortcut_first(first) {
        return Some("must start with a letter, a digit or one of ; , \\ = +");
    }
    if key.chars().any(whitespace) {
        return Some("contains whitespace");
    }
    None
}

fn word_problem(word: &str) -> Option<&'static str> {
    if unsafe_text(word).is_some() {
        return Some("contains a control or bidirectional character");
    }
    if word.is_empty() {
        return Some("is empty");
    }
    if code_point_length(word) > WORD_CODE_POINTS {
        return Some("is longer than 64 characters");
    }
    if word.chars().any(whitespace) {
        return Some("contains whitespace");
    }
    None
}

/// Why a `file` reference is refused before any read.
pub fn reference_path_problem(path: &str) -> Option<&'static str> {
    let b = path.as_bytes();
    if path.starts_with('/')
        || path.starts_with('\\')
        || (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':')
    {
        return Some("absolute");
    }
    if path.is_empty()
        || path.contains('\0')
        || path.contains('\\')
        || path.split('/').any(|p| p == "..")
    {
        return Some("traversal");
    }
    None
}

const TWO_53: f64 = 9_007_199_254_740_992.0;

/// TOML data as JSON for plugin settings, or None when it has no JSON form.
fn to_json(value: &Value) -> Option<Json> {
    Some(match value {
        Value::String(s) => Json::String(s.clone()),
        Value::Boolean(b) => Json::Bool(*b),
        Value::Integer(i) => {
            if (*i as f64).abs() >= TWO_53 || i.unsigned_abs() >= 1u64 << 53 {
                return None;
            }
            Json::Number((*i).into())
        }
        Value::Float(f) => {
            if !f.is_finite() || f.abs() >= TWO_53 {
                return None;
            }
            Json::Number(Number::from_f64(*f)?)
        }
        Value::Array(items) => Json::Array(items.iter().map(to_json).collect::<Option<Vec<_>>>()?),
        Value::Table(t) => {
            let mut out = Map::new();
            for (k, v) in t {
                out.insert(k.clone(), to_json(v)?);
            }
            Json::Object(out)
        }
        Value::Datetime(_) => return None,
    })
}

/// Collects one file's diagnostics, each placed by the key locator.
struct Checker<'a> {
    file: &'a str,
    source: &'a str,
    locator: &'a Locator,
    diagnostics: Vec<Diagnostic>,
}

impl Checker<'_> {
    fn at(&self, path: &[&str]) -> Position {
        self.locator.locate(path)
    }

    fn report(&mut self, severity: Severity, code: &'static str, path: &[&str], message: &str) {
        let at = self.locator.locate(path);
        let excerpt = excerpt_at(self.source, at.line);
        self.diagnostics.push(Diagnostic::new(
            severity,
            code,
            self.file,
            at,
            message,
            excerpt.as_deref(),
        ));
    }

    fn warn(&mut self, code: &'static str, path: &[&str], message: &str) {
        self.report(Severity::Warning, code, path, message);
    }

    fn unknown(&mut self, path: &[&str], label: &str) {
        self.warn("unknown-key", path, &format!("unknown key {label} ignored"));
    }
}

fn with_excerpt(mut file: ConfigFile, source: &str) -> ConfigFile {
    if let Some(first) = file.diagnostics.first_mut() {
        if let Some(e) = excerpt_at(source, first.line) {
            first.excerpt = Some(crate::text_policy::display_text(&e));
        }
    }
    file
}

/// Why an expansion can't be inserted, or None.
pub fn expansion_problem(text: &str) -> Option<(&'static str, String)> {
    if text.len() > EXPANSION_BYTES {
        return Some(("expansion-too-large", "is larger than 16 KiB".into()));
    }
    unsafe_text(text).map(|u| ("unsafe-text", format!("contains a {u}")))
}

/// Parses and checks one config file (see `parseConfig` in `src/schema.ts`).
pub fn parse_config(text: &str, file: &str, origin: Origin) -> ConfigFile {
    if text.len() > CONFIG_FILE_BYTES {
        return ignored_file(
            file,
            origin,
            "too-large",
            "file is larger than 256 KiB and was not read",
            FILE_START,
            None,
        );
    }
    let source = normalize_toml(text);
    let scan = scan_source(&source);
    if let Some(at) = scan.overflow {
        let message = "arrays or tables nest deeper than 32 levels; file ignored";
        return with_excerpt(
            ignored_file(file, origin, "too-deep", message, at, None),
            &source,
        );
    }
    let data = match source.parse::<toml::Table>() {
        Ok(t) => t,
        Err(e) => {
            let at = parser_position(&source, e.span().map_or(0, |s| s.start));
            let reason = e
                .message()
                .lines()
                .next()
                .unwrap_or("invalid TOML")
                .to_string();
            let message = format!("not valid TOML: {reason}");
            return with_excerpt(
                ignored_file(file, origin, "parse", &message, at, None),
                &source,
            );
        }
    };
    let mut check = Checker {
        file,
        source: &source,
        locator: &scan.locator,
        diagnostics: Vec::new(),
    };

    if let Some(version) = data.get("version") {
        let one =
            matches!(version, Value::Integer(1)) || matches!(version, Value::Float(f) if *f == 1.0);
        if !one {
            let at = check.at(&["version"]);
            let message = "unsupported version; this Murmo reads version 1";
            return with_excerpt(
                ignored_file(file, origin, "unsupported-version", message, at, None),
                &source,
            );
        }
    }

    let mut config = ConfigFile {
        file: file.to_string(),
        origin,
        ok: true,
        language: None,
        shortcuts: Vec::new(),
        protect: Vec::new(),
        autocorrect: None,
        names: None,
        phrases_learn: None,
        history_enabled: None,
        plugin_order: None,
        plugins: BTreeMap::new(),
        private: None,
        events: None,
        events_fail_open: None,
        diagnostics: Vec::new(),
    };
    for (key, value) in &data {
        match key.as_str() {
            "version" => {}
            "language" => match value {
                Value::String(s) if language_tag(s) => config.language = Some(s.clone()),
                Value::String(_) => {
                    check.warn(
                        "invalid-value",
                        &[key],
                        "language must be a language tag such as \"en\"",
                    );
                }
                _ => check.warn("invalid-type", &[key], "language must be a string"),
            },
            "replace" => config.shortcuts = check_replace(&mut check, value),
            "words" => config.protect = check_words(&mut check, value),
            "autocorrect" => {
                config.autocorrect = check_switch(&mut check, value, "autocorrect", "enabled")
            }
            "names" => config.names = check_names(&mut check, value),
            "phrases" => config.phrases_learn = check_switch(&mut check, value, "phrases", "learn"),
            "history" => {
                config.history_enabled = check_switch(&mut check, value, "history", "enabled")
            }
            "plugins" => (config.plugin_order, config.plugins) = check_plugins(&mut check, value),
            "privacy" => config.private = check_switch(&mut check, value, "privacy", "private"),
            "events" => {
                let (enabled, fail_open) = check_events(&mut check, value);
                config.events = enabled;
                config.events_fail_open = fail_open;
            }
            _ => check.unknown(&[key], &format!("\"{key}\"")),
        }
    }
    if origin == Origin::Project {
        if config.autocorrect == Some(true) {
            check.warn(
                "project-only-reduces",
                &["autocorrect", "enabled"],
                "a project file can only turn autocorrect off; \"enabled = true\" ignored",
            );
            config.autocorrect = None;
        }
        if let Some(names) = config.names.as_mut() {
            if names.enabled == Some(true) {
                check.warn(
                    "project-only-reduces",
                    &["names", "enabled"],
                    "a project file can only turn names off; \"enabled = true\" ignored",
                );
                names.enabled = None;
            }
        }
        if config.phrases_learn == Some(true) {
            check.warn(
                "project-only-reduces",
                &["phrases", "learn"],
                "a project file can only turn phrase learning off; \"learn = true\" ignored",
            );
            config.phrases_learn = None;
        }
        if config.history_enabled == Some(true) {
            check.warn(
                "project-only-reduces",
                &["history", "enabled"],
                "a project file can only turn history off; \"enabled = true\" ignored",
            );
            config.history_enabled = None;
        }
        if config.private == Some(false) {
            config.private = None;
        }
        if config.events == Some(true) {
            check.warn(
                "project-only-reduces",
                &["events", "enabled"],
                "a project file can only turn events off; \"enabled = true\" ignored",
            );
            config.events = None;
        }
        if config.plugin_order.is_some() {
            check.warn(
                "project-only-reduces",
                &["plugins", "order"],
                "plugin order in a project file is ignored; only your murmo.toml sets it",
            );
            config.plugin_order = None;
        }
        for (id, table) in config.plugins.iter_mut() {
            if table.enabled == Some(true) {
                check.warn(
                    "project-only-reduces",
                    &["plugins", id, "enabled"],
                    &format!("a project file can only turn plugin \"{id}\" off; \"enabled = true\" ignored"),
                );
                table.enabled = None;
            }
        }
    }
    sort_diagnostics(&mut check.diagnostics);
    config.diagnostics = check.diagnostics;
    config
}

fn check_replace(check: &mut Checker, value: &Value) -> Vec<ShortcutEntry> {
    let Value::Table(table) = value else {
        check.warn("invalid-type", &["replace"], "[replace] must be a table");
        return Vec::new();
    };
    if table.len() > SHORTCUTS_PER_FILE {
        let message = format!(
            "[replace] has {} shortcuts; at most 1000 per file, so none were loaded",
            table.len()
        );
        check.report(
            Severity::Error,
            "too-many-shortcuts",
            &["replace"],
            &message,
        );
        return Vec::new();
    }
    let mut entries = Vec::new();
    for (shortcut, entry) in table {
        let path = ["replace", shortcut.as_str()];
        if let Some(problem) = shortcut_problem(shortcut) {
            check.warn(
                "invalid-shortcut",
                &path,
                &format!("shortcut \"{shortcut}\" {problem}; skipped"),
            );
            continue;
        }
        match entry {
            Value::String(text) => match expansion_problem(text) {
                Some((code, message)) => {
                    check.warn(code, &path, &format!("expansion of \"{shortcut}\" {message}; skipped"));
                }
                None => entries.push(ShortcutEntry::Text { shortcut: shortcut.clone(), text: text.clone(), at: check.at(&path) }),
            },
            Value::Table(t) if t.contains_key("file") => {
                for extra in t.keys().filter(|k| *k != "file") {
                    check.unknown(&["replace", shortcut, extra], &format!("\"{extra}\" in \"{shortcut}\""));
                }
                match &t["file"] {
                    Value::String(file) => {
                        entries.push(ShortcutEntry::File { shortcut: shortcut.clone(), path: file.clone(), at: check.at(&path) });
                    }
                    _ => check.warn("invalid-type", &path, &format!("file of \"{shortcut}\" must be a string; skipped")),
                }
            }
            _ => check.warn(
                "invalid-type",
                &path,
                &format!("shortcut \"{shortcut}\" must be a string or {{ file = \"\u{2026}\" }}; skipped"),
            ),
        }
    }
    entries
}

fn check_words(check: &mut Checker, value: &Value) -> Vec<String> {
    let Value::Table(table) = value else {
        check.warn("invalid-type", &["words"], "[words] must be a table");
        return Vec::new();
    };
    let mut words: Vec<String> = Vec::new();
    for (key, list) in table {
        if key != "protect" {
            check.unknown(&["words", key], &format!("\"{key}\" in [words]"));
            continue;
        }
        let Value::Array(list) = list else {
            check.warn(
                "invalid-type",
                &["words", key],
                "protect must be a list of words",
            );
            continue;
        };
        for word in list {
            let Value::String(word) = word else {
                check.warn(
                    "invalid-type",
                    &["words", key],
                    "protect must be a list of words",
                );
                continue;
            };
            match word_problem(word) {
                Some(problem) => check.warn(
                    "invalid-value",
                    &["words", key],
                    &format!("word \"{word}\" {problem}; skipped"),
                ),
                None if !words.contains(word) => words.push(word.clone()),
                None => {}
            }
        }
    }
    words
}

fn is_canonical_key(id: &str) -> bool {
    const NAMED: &[&str] = &[
        "space",
        "Tab",
        "Enter",
        "Backspace",
        "Escape",
        "Up",
        "Down",
        "Left",
        "Right",
        "F1",
        "F2",
        "F3",
        "F4",
        "F5",
        "F6",
        "F7",
        "F8",
        "F9",
        "F10",
        "F11",
        "F12",
    ];
    let mut rest = id;
    let mut used: Vec<&str> = Vec::new();
    for modifier in ["Ctrl", "Alt", "Shift"] {
        let prefix = format!("{modifier}+");
        if rest.starts_with(&prefix) && rest.len() > prefix.len() {
            used.push(modifier);
            rest = &rest[prefix.len()..];
        }
    }
    if NAMED.contains(&rest) {
        return true;
    }
    let chars: Vec<char> = rest.chars().collect();
    if chars.len() != 1 {
        return false;
    }
    let c = chars[0];
    if c.is_whitespace() || c.is_control() {
        return false;
    }
    if used.contains(&"Shift") {
        return false;
    }
    used.is_empty() || rest.chars().all(|ch| !ch.is_uppercase())
}

fn name_language(s: &str) -> bool {
    matches!(s, "rust" | "typescript" | "javascript" | "python" | "go")
}

fn check_names(check: &mut Checker, value: &Value) -> Option<NamesSettings> {
    let Value::Table(table) = value else {
        check.warn("invalid-type", &["names"], "[names] must be a table");
        return None;
    };
    let mut enabled = None;
    let mut key = None;
    let mut languages: Option<Vec<String>> = None;
    let mut max_file_bytes = None;
    for (name, entry) in table {
        let path = ["names", name.as_str()];
        match name.as_str() {
            "enabled" => match entry {
                Value::Boolean(b) => enabled = Some(*b),
                _ => check.warn("invalid-type", &path, "enabled must be true or false"),
            },
            "key" => match entry {
                Value::String(s) if is_canonical_key(s) => key = Some(s.clone()),
                Value::String(s) => check.warn(
                    "invalid-value",
                    &path,
                    &format!("key \"{s}\" is not a canonical key; skipped"),
                ),
                _ => check.warn("invalid-type", &path, "key must be a string"),
            },
            "languages" => match entry {
                Value::Array(list) => {
                    let mut out = Vec::new();
                    for item in list {
                        match item {
                            Value::String(s) if name_language(s) && !out.contains(s) => out.push(s.clone()),
                            _ => check.warn(
                                "invalid-value",
                                &path,
                                "languages must list rust, typescript, javascript, python or go; entry skipped",
                            ),
                        }
                    }
                    languages = Some(out);
                }
                _ => check.warn(
                    "invalid-type",
                    &path,
                    "languages must be a list of language names",
                ),
            },
            "maxFileBytes" => match entry {
                Value::Integer(n) if *n >= 1 && *n <= 1_048_576 => max_file_bytes = Some(*n as u64),
                _ => check.warn(
                    "invalid-value",
                    &path,
                    "maxFileBytes must be an integer from 1 to 1048576",
                ),
            },
            _ => check.unknown(&path, &format!("\"{name}\" in [names]")),
        }
    }
    if enabled.is_none() && key.is_none() && languages.is_none() && max_file_bytes.is_none() {
        return None;
    }
    Some(NamesSettings {
        enabled,
        key,
        languages,
        max_file_bytes,
    })
}

fn check_switch(check: &mut Checker, value: &Value, table: &str, name: &str) -> Option<bool> {
    let Value::Table(t) = value else {
        check.warn(
            "invalid-type",
            &[table],
            &format!("[{table}] must be a table"),
        );
        return None;
    };
    let mut result = None;
    for (key, flag) in t {
        if key != name {
            check.unknown(&[table, key], &format!("\"{key}\" in [{table}]"));
            continue;
        }
        match flag {
            Value::Boolean(b) => result = Some(*b),
            _ => check.warn(
                "invalid-type",
                &[table, key],
                &format!("{name} must be true or false"),
            ),
        }
    }
    result
}

fn check_events(check: &mut Checker, value: &Value) -> (Option<bool>, Option<bool>) {
    let Value::Table(t) = value else {
        check.warn("invalid-type", &["events"], "[events] must be a table");
        return (None, None);
    };
    let mut enabled = None;
    let mut fail_open = None;
    for (key, flag) in t {
        if key == "enabled" {
            match flag {
                Value::Boolean(b) => enabled = Some(*b),
                _ => check.warn(
                    "invalid-type",
                    &["events", key],
                    "enabled must be true or false",
                ),
            }
        } else if key == "failOpen" {
            match flag {
                Value::Boolean(b) => fail_open = Some(*b),
                _ => check.warn(
                    "invalid-type",
                    &["events", key],
                    "failOpen must be true or false",
                ),
            }
        } else {
            check.unknown(&["events", key], &format!("\"{key}\" in [events]"));
        }
    }
    (enabled, fail_open)
}

fn check_plugins(
    check: &mut Checker,
    value: &Value,
) -> (Option<Vec<String>>, BTreeMap<String, PluginTable>) {
    let mut tables = BTreeMap::new();
    let Value::Table(t) = value else {
        check.warn("invalid-type", &["plugins"], "[plugins] must be a table");
        return (None, tables);
    };
    let mut order = None;
    for (key, entry) in t {
        if key == "order" {
            let Value::Array(list) = entry else {
                check.warn(
                    "invalid-type",
                    &["plugins", key],
                    "order must be a list of plugin names",
                );
                continue;
            };
            let mut ids: Vec<String> = Vec::new();
            for id in list {
                match id {
                    Value::String(id) if plugin_id(id) => {
                        if ids.contains(id) {
                            check.warn(
                                "invalid-value",
                                &["plugins", key],
                                &format!("plugin \"{id}\" is listed twice; kept the first"),
                            );
                        } else {
                            ids.push(id.clone());
                        }
                    }
                    _ => check.warn(
                        "invalid-value",
                        &["plugins", key],
                        "order must list plugin names; entry skipped",
                    ),
                }
            }
            order = Some(ids);
            continue;
        }
        let path = ["plugins", key.as_str()];
        if !plugin_id(key) {
            check.warn(
                "invalid-value",
                &path,
                &format!("\"{key}\" is not a plugin name; ignored"),
            );
            continue;
        }
        let Value::Table(entry) = entry else {
            check.warn(
                "invalid-type",
                &path,
                &format!("[plugins.{key}] must be a table"),
            );
            continue;
        };
        let mut enabled = None;
        let mut settings = Map::new();
        for (name, setting) in entry {
            if name == "enabled" {
                match setting {
                    Value::Boolean(b) => enabled = Some(*b),
                    _ => check.warn(
                        "invalid-type",
                        &["plugins", key, name],
                        "enabled must be true or false",
                    ),
                }
                continue;
            }
            match to_json(setting) {
                Some(json) => {
                    settings.insert(name.clone(), json);
                }
                None => check.warn(
                    "invalid-value",
                    &["plugins", key, name],
                    &format!(
                        "setting \"{name}\" of plugin \"{key}\" is not JSON data (a date, or a number that is not finite or not below 2^53); skipped"
                    ),
                ),
            }
        }
        tables.insert(
            key.clone(),
            PluginTable {
                enabled,
                settings,
                at: check.at(&path),
            },
        );
    }
    (order, tables)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_ids_follow_the_manifest_rule() {
        // A [plugins.<id>] table the manifest rule refuses could never match
        // an installed plugin; JS and Rust must refuse the same ones.
        assert!(plugin_id("rescue"));
        assert!(plugin_id("@me/rescue-2"));
        assert!(!plugin_id("@me/"));
        assert!(!plugin_id("Rescue"));
        assert!(!plugin_id("-x"));
        assert!(!plugin_id(&"a".repeat(65)));
    }

    #[test]
    fn references_that_leave_the_repository_are_refused_by_spelling() {
        // r8 trust cases: these must be refused before any file is opened.
        assert_eq!(reference_path_problem("../../etc/hosts"), Some("traversal"));
        assert_eq!(reference_path_problem("/etc/hosts"), Some("absolute"));
        assert_eq!(
            reference_path_problem("C:\\Windows\\system.ini"),
            Some("absolute")
        );
        assert_eq!(reference_path_problem("a/../b"), Some("traversal"));
        assert_eq!(reference_path_problem(".murmo/a.md"), None);
    }

    #[test]
    fn a_project_file_can_only_do_less() {
        // An untrusted repository must not be able to turn autocorrect or a
        // plugin on for the user.
        let src = "[autocorrect]\nenabled = true\n[plugins.menu]\nenabled = true\n[privacy]\nprivate = false\n";
        let c = parse_config(src, ".murmo.toml", Origin::Project);
        assert_eq!(c.autocorrect, None);
        assert_eq!(c.private, None);
        assert_eq!(c.plugins["menu"].enabled, None);
        assert_eq!(
            c.diagnostics
                .iter()
                .filter(|d| d.code == "project-only-reduces")
                .count(),
            2
        );
    }
}

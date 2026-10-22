//! Defaults < user file < project file (port of `src/merge.ts`).

use std::collections::BTreeMap;

use serde_json::{json, Map, Value as Json};

use crate::diagnostics::{sort_diagnostics, Diagnostic, Position, Severity, FILE_START};
use crate::references::{LoadedConfig, Shortcut};

#[derive(Clone, Debug, PartialEq)]
pub struct EffectivePlugin {
    pub enabled: Option<bool>,
    pub settings: Map<String, Json>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EffectiveConfig {
    pub language: Option<String>,
    pub replacements: Vec<Shortcut>,
    pub overrides: Vec<String>,
    pub protect: Vec<String>,
    pub autocorrect: bool,
    pub names: Option<crate::schema::NamesSettings>,
    pub phrases_learn: bool,
    pub history_enabled: bool,
    pub plugin_order: Option<Vec<String>>,
    pub plugins: BTreeMap<String, EffectivePlugin>,
    pub private: bool,
    pub events: bool,
    pub events_fail_open: bool,
    pub diagnostics: Vec<Diagnostic>,
}

impl EffectiveConfig {
    pub fn to_json(&self) -> Json {
        let mut plugins = Map::new();
        for (id, p) in &self.plugins {
            let mut v = json!({ "settings": p.settings });
            if let Some(e) = p.enabled {
                v["enabled"] = json!(e);
            }
            plugins.insert(id.clone(), v);
        }
        let mut v = json!({
            "replacements": self.replacements.iter().map(Shortcut::to_json).collect::<Vec<_>>(),
            "overrides": self.overrides,
            "protect": self.protect,
            "autocorrect": self.autocorrect,
            "phrasesLearn": self.phrases_learn,
            "historyEnabled": self.history_enabled,
            "plugins": plugins,
            "private": self.private,
            "events": self.events,
            "eventsFailOpen": self.events_fail_open,
            "diagnostics": self.diagnostics.iter().map(Diagnostic::to_json).collect::<Vec<_>>(),
        });
        if let Some(l) = &self.language {
            v["language"] = json!(l);
        }
        if let Some(o) = &self.plugin_order {
            v["pluginOrder"] = json!(o);
        }
        if let Some(n) = &self.names {
            v["names"] = n.to_json();
        }
        v
    }
}

fn plural(n: usize, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}

pub fn merge_config(
    user: Option<&LoadedConfig>,
    project: Option<&LoadedConfig>,
    project_trusted: bool,
) -> EffectiveConfig {
    let user_file = user.filter(|u| u.config.ok);
    let project_file = project.filter(|p| p.config.ok);
    let mut notices = Vec::new();

    let mut replacements: BTreeMap<String, Shortcut> = BTreeMap::new();
    for s in user_file
        .map(|u| u.replacements.as_slice())
        .unwrap_or_default()
    {
        replacements.insert(s.shortcut.clone(), s.clone());
    }
    let mut overrides = Vec::new();
    if let (Some(p), true) = (project_file, project_trusted) {
        for s in &p.replacements {
            if replacements.contains_key(&s.shortcut) {
                overrides.push(s.shortcut.clone());
                let at: Position = p
                    .config
                    .shortcuts
                    .iter()
                    .find(|e| e.shortcut() == s.shortcut)
                    .map_or(FILE_START, |e| e.at());
                let message = format!(
                    "project shortcut \"{}\" overrides your personal one",
                    s.shortcut
                );
                notices.push(Diagnostic::new(
                    Severity::Notice,
                    "override",
                    &p.config.file,
                    at,
                    &message,
                    None,
                ));
            }
            replacements.insert(s.shortcut.clone(), s.clone());
        }
    }

    let mut protect: Vec<String> = user_file
        .map(|u| u.config.protect.clone())
        .unwrap_or_default();
    for word in project_file
        .map(|p| p.config.protect.as_slice())
        .unwrap_or_default()
    {
        if !protect.contains(word) {
            protect.push(word.clone());
        }
    }

    let autocorrect = if project_file.and_then(|p| p.config.autocorrect) == Some(false) {
        false
    } else {
        user_file
            .and_then(|u| u.config.autocorrect)
            .unwrap_or(false)
    };
    let phrases_learn = if project_file.and_then(|p| p.config.phrases_learn) == Some(false) {
        false
    } else {
        user_file
            .and_then(|u| u.config.phrases_learn)
            .unwrap_or(false)
    };
    let history_enabled = if project_file.and_then(|p| p.config.history_enabled) == Some(false) {
        false
    } else {
        user_file
            .and_then(|u| u.config.history_enabled)
            .unwrap_or(false)
    };
    let private = project_file.and_then(|p| p.config.private) == Some(true)
        || user_file.and_then(|u| u.config.private).unwrap_or(false);
    let events = if project_file.and_then(|p| p.config.events) == Some(false) {
        false
    } else {
        user_file.and_then(|u| u.config.events).unwrap_or(false)
    };
    let events_fail_open = user_file
        .and_then(|u| u.config.events_fail_open)
        .unwrap_or(false);

    let mut plugins: BTreeMap<String, EffectivePlugin> = BTreeMap::new();
    if let Some(u) = user_file {
        for (id, t) in &u.config.plugins {
            plugins.insert(
                id.clone(),
                EffectivePlugin {
                    enabled: t.enabled,
                    settings: t.settings.clone(),
                },
            );
        }
    }
    let mut untrusted_plugins = 0;
    if let Some(p) = project_file {
        for (id, t) in &p.config.plugins {
            let current = plugins.get(id).cloned().unwrap_or(EffectivePlugin {
                enabled: None,
                settings: Map::new(),
            });
            let enabled = if t.enabled == Some(false) {
                Some(false)
            } else {
                current.enabled
            };
            let mut settings = current.settings;
            if !t.settings.is_empty() {
                if project_trusted {
                    for (k, v) in &t.settings {
                        settings.insert(k.clone(), v.clone());
                    }
                } else {
                    untrusted_plugins += 1;
                }
            }
            plugins.insert(id.clone(), EffectivePlugin { enabled, settings });
        }
    }

    if let (Some(p), false) = (project_file, project_trusted) {
        let shortcuts = p.replacements.len();
        if shortcuts > 0 || untrusted_plugins > 0 {
            let mut parts = Vec::new();
            if shortcuts > 0 {
                parts.push(plural(shortcuts, "shortcut"));
            }
            if untrusted_plugins > 0 {
                parts.push(format!(
                    "settings for {}",
                    plural(untrusted_plugins, "plugin")
                ));
            }
            let message = format!(
                "{} stay off until you review this file: run \"murmo trust\"",
                parts.join(" and ")
            );
            notices.push(Diagnostic::new(
                Severity::Notice,
                "untrusted",
                &p.config.file,
                FILE_START,
                &message,
                None,
            ));
        }
    }

    overrides.sort();
    let mut project_diagnostics: Vec<Diagnostic> = project
        .map(|p| p.config.diagnostics.clone())
        .unwrap_or_default();
    project_diagnostics.extend(notices);
    sort_diagnostics(&mut project_diagnostics);
    let mut diagnostics = user
        .map(|u| u.config.diagnostics.clone())
        .unwrap_or_default();
    diagnostics.extend(project_diagnostics);

    EffectiveConfig {
        language: project_file
            .and_then(|p| p.config.language.clone())
            .or_else(|| user_file.and_then(|u| u.config.language.clone())),
        replacements: replacements.into_values().collect(),
        overrides,
        protect,
        autocorrect,
        names: {
            let mut names = user_file.and_then(|u| u.config.names.clone());
            if project_file.and_then(|p| p.config.names.as_ref().and_then(|n| n.enabled))
                == Some(false)
            {
                let mut n = names.unwrap_or(crate::schema::NamesSettings {
                    enabled: None,
                    key: None,
                    languages: None,
                    max_file_bytes: None,
                    lsp: None,
                });
                n.enabled = Some(false);
                names = Some(n);
            }
            names
        },
        phrases_learn,
        history_enabled,
        plugin_order: user_file.and_then(|u| u.config.plugin_order.clone()),
        plugins,
        private,
        events,
        events_fail_open,
        diagnostics,
    }
}

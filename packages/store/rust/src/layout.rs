//! Where Murmo keeps every byte it writes (port of `src/layout.ts`).

use std::path::{Path, PathBuf};

use crate::sha256_hex;

/// The three Murmo roots: data that must survive, state that may be lost,
/// caches that can be rebuilt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoreRoots {
    pub data: PathBuf,
    pub state: PathBuf,
    pub cache: PathBuf,
}

pub const STORE_VERSION: &str = "v1";

#[derive(Clone, Debug)]
pub struct StoreLayout {
    pub roots: StoreRoots,
    pub store: PathBuf,
    pub meta: PathBuf,
    pub trust: PathBuf,
    pub words: PathBuf,
    pub plugins: PathBuf,
    pub projects: PathBuf,
    pub logs: PathBuf,
    pub drafts: PathBuf,
    pub private_flag: PathBuf,
}

impl StoreLayout {
    pub fn new(roots: StoreRoots) -> Self {
        let store = roots.data.join("store").join(STORE_VERSION);
        StoreLayout {
            meta: store.join("meta.json"),
            trust: store.join("trust.json"),
            words: store.join("words.json"),
            plugins: store.join("plugins"),
            projects: store.join("projects"),
            logs: store.join("logs"),
            drafts: roots.state.join("drafts").join(STORE_VERSION),
            private_flag: roots.state.join("private"),
            store,
            roots,
        }
    }

    /// A plugin's namespace file: its ID hashed, so any ID is a safe file name.
    pub fn plugin_record(&self, plugin_id: &str) -> PathBuf {
        self.plugins
            .join(format!("{}.json", sha256_hex(plugin_id.as_bytes())))
    }

    pub fn project_directory(&self, project_id: &str) -> Option<PathBuf> {
        check_project_id(project_id).then(|| self.projects.join(project_id))
    }

    pub fn project_words(&self, project_id: &str) -> Option<PathBuf> {
        self.project_directory(project_id)
            .map(|d| d.join("words.json"))
    }

    pub fn log_directory(&self, kind: &str) -> Option<PathBuf> {
        LOG_KINDS.contains(&kind).then(|| self.logs.join(kind))
    }

    /// Packed phrase index (phase 34).
    pub fn phrase_directory(&self, project_id: Option<&str>) -> Option<PathBuf> {
        match project_id {
            None => Some(self.store.join("phrases")),
            Some(id) => self.project_directory(id).map(|d| d.join("phrases")),
        }
    }
}

pub const LOG_KINDS: [&str; 2] = ["phrases", "history"];

/// A project ID is a SHA-256 hex digest; anything else could escape the layout.
pub fn check_project_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Session IDs name log segments: 1-64 letters, digits or `-`.
pub fn check_session_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// An XDG variable counts only when it is an absolute path.
fn xdg(get: &dyn Fn(&str) -> Option<String>, name: &str, fallback: PathBuf) -> PathBuf {
    match get(name) {
        Some(value) if Path::new(&value).is_absolute() => PathBuf::from(value),
        _ => fallback,
    }
}

/// `$XDG_DATA_HOME/murmo`, `$XDG_STATE_HOME/murmo`, `$XDG_CACHE_HOME/murmo`
/// with the XDG defaults under `home` (macOS too).
pub fn roots_from_env(get: &dyn Fn(&str) -> Option<String>, home: &Path) -> StoreRoots {
    StoreRoots {
        data: xdg(get, "XDG_DATA_HOME", home.join(".local").join("share")).join("murmo"),
        state: xdg(get, "XDG_STATE_HOME", home.join(".local").join("state")).join("murmo"),
        cache: xdg(get, "XDG_CACHE_HOME", home.join(".cache")).join("murmo"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_xdg_values_are_ignored() {
        // The XDG spec says relative values are invalid; using one would write
        // into whatever directory the host started in.
        let get = |name: &str| (name == "XDG_DATA_HOME").then(|| "relative/dir".to_string());
        let roots = roots_from_env(&get, Path::new("/home/u"));
        assert_eq!(roots.data, PathBuf::from("/home/u/.local/share/murmo"));
        assert_eq!(roots.cache, PathBuf::from("/home/u/.cache/murmo"));
    }

    #[test]
    fn project_ids_cannot_escape_the_layout() {
        let layout = StoreLayout::new(roots_from_env(&|_| None, Path::new("/h")));
        assert!(layout.project_directory("../../etc").is_none());
        assert!(layout.project_directory(&"A".repeat(64)).is_none());
        assert!(layout.project_directory(&"a".repeat(64)).is_some());
        assert!(!check_session_id("a/b"));
        assert!(check_session_id("abc-1"));
    }
}

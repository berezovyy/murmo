//! Loading (port of `src/node/load.ts`): find the files, read them within
//! bounds, check the project file's trust against the store, merge. Runs at
//! session start and on idle re-checks, never in the key handler.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Read};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use murmo_store::files::ModeRepairs;
use murmo_store::record::{read_record, RecordRead};
use murmo_store::records::{RecordKind, RECORD_MAX_BYTES};
use murmo_store::{find_repository_root, project_identity, ProjectIdentity, StoreLayout};
use serde_json::{json, Value as Json};

use crate::diagnostics::FILE_START;
use crate::limits::{CONFIG_FILE_BYTES, REFERENCE_BYTES, SNAPSHOT_BYTES, SNAPSHOT_READS};
use crate::merge::{merge_config, EffectiveConfig};
use crate::reader::{read_inside, ReadBudget};
use crate::references::{
    referenced_paths, resolve_shortcuts, LoadedConfig, ReferenceProblem, ReferenceRead,
};
use crate::schema::{ignored_file, parse_config, ConfigFile, Origin};
use crate::trust::{trust_manifest, PinnedFile};

pub const PROJECT_FILE: &str = ".murmo.toml";

/// `$XDG_CONFIG_HOME/murmo/murmo.toml`, default `~/.config/murmo/murmo.toml`.
pub fn user_config_path(get: &dyn Fn(&str) -> Option<String>, home: &Path) -> PathBuf {
    let base = match get("XDG_CONFIG_HOME") {
        Some(v) if Path::new(&v).is_absolute() => PathBuf::from(v),
        _ => home.join(".config"),
    };
    base.join("murmo").join("murmo.toml")
}

/// What the idle re-check compares: `dev:ino:size:mtime:ctime`, or `missing`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileStamp {
    pub path: PathBuf,
    pub stamp: String,
}

pub fn stamp_of(path: &Path) -> FileStamp {
    let stamp = match fs::symlink_metadata(path) {
        Ok(m) => format!(
            "{}:{}:{}:{}.{}:{}.{}",
            m.dev(),
            m.ino(),
            m.len(),
            m.mtime(),
            m.mtime_nsec(),
            m.ctime(),
            m.ctime_nsec()
        ),
        Err(_) => "missing".into(),
    };
    FileStamp {
        path: path.to_path_buf(),
        stamp,
    }
}

fn new_budget() -> ReadBudget {
    ReadBudget {
        bytes: SNAPSHOT_BYTES,
        reads: SNAPSHOT_READS,
    }
}

fn file_problem(file: &str, origin: Origin, problem: ReferenceProblem) -> LoadedConfig {
    let config = if problem == ReferenceProblem::TooLarge {
        ignored_file(
            file,
            origin,
            "too-large",
            "file is larger than 256 KiB and was not read",
            FILE_START,
            None,
        )
    } else {
        let message = format!("file {}; ignored", problem.message());
        ignored_file(file, origin, "unreadable", &message, FILE_START, None)
    };
    LoadedConfig {
        config,
        replacements: Vec::new(),
    }
}

struct References {
    reads: HashMap<String, ReferenceRead>,
    pinned: Vec<PinnedFile>,
    complete: bool,
}

fn read_references(
    config: &ConfigFile,
    root: &Path,
    budget: &mut ReadBudget,
    stamps: &mut Vec<FileStamp>,
) -> References {
    let mut refs = References {
        reads: HashMap::new(),
        pinned: Vec::new(),
        complete: true,
    };
    for path in referenced_paths(config) {
        let read = read_inside(root, &path, REFERENCE_BYTES, Some(budget));
        stamps.push(stamp_of(&root.join(&path)));
        match read {
            Ok(file) => {
                if file.resolved != path {
                    stamps.push(stamp_of(&root.join(&file.resolved)));
                }
                refs.pinned.push(PinnedFile {
                    path: path.clone(),
                    resolved: file.resolved,
                    links: file.links,
                    sha256: file.sha256,
                });
                refs.reads.insert(path, ReferenceRead::Ok(file.text));
            }
            Err(problem) => {
                refs.reads.insert(path, ReferenceRead::Refused(problem));
                refs.complete = false;
            }
        }
    }
    refs
}

/// The personal file; a symlinked `murmo.toml` (a dotfiles checkout) is followed.
pub fn load_user_config(path: &Path) -> (Option<LoadedConfig>, Vec<FileStamp>) {
    let mut stamps = vec![stamp_of(path)];
    let file = path.to_string_lossy().into_owned();
    let problem = |p| file_problem(&file, Origin::User, p);
    let mut handle = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
    {
        Ok(h) => h,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return (None, stamps),
        Err(_) => return (Some(problem(ReferenceProblem::Unreadable)), stamps),
    };
    let meta = match handle.metadata() {
        Ok(m) => m,
        Err(_) => return (Some(problem(ReferenceProblem::Unreadable)), stamps),
    };
    if !meta.is_file() {
        return (Some(problem(ReferenceProblem::NotRegular)), stamps);
    }
    if meta.len() > CONFIG_FILE_BYTES as u64 {
        return (Some(problem(ReferenceProblem::TooLarge)), stamps);
    }
    let mut bytes = Vec::new();
    if Read::take(&mut handle, CONFIG_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return (Some(problem(ReferenceProblem::Unreadable)), stamps);
    }
    if bytes.len() > CONFIG_FILE_BYTES {
        return (Some(problem(ReferenceProblem::TooLarge)), stamps);
    }
    let Ok(text) = String::from_utf8(bytes) else {
        return (Some(problem(ReferenceProblem::InvalidUtf8)), stamps);
    };
    let parsed = parse_config(&text, &file, Origin::User);
    let root = fs::canonicalize(path)
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_default();
    let refs = read_references(&parsed, &root, &mut new_budget(), &mut stamps);
    (Some(resolve_shortcuts(parsed, &refs.reads)), stamps)
}

pub struct ProjectSnapshot {
    pub identity: ProjectIdentity,
    pub config: LoadedConfig,
    /// Absent when the snapshot can't be approved (ignored file, unreadable reference).
    pub fingerprint: Option<String>,
    pub stamps: Vec<FileStamp>,
}

/// Reads `.murmo.toml` at `root` and everything it references, as one snapshot.
pub fn scan_project(root: &Path) -> io::Result<Option<ProjectSnapshot>> {
    let identity = project_identity(root)?;
    let file_path = identity.root.join(PROJECT_FILE);
    let mut stamps = vec![stamp_of(&file_path)];
    if stamps[0].stamp == "missing" {
        return Ok(None);
    }
    let file = file_path.to_string_lossy().into_owned();
    let mut budget = new_budget();
    let read = match read_inside(
        &identity.root,
        PROJECT_FILE,
        CONFIG_FILE_BYTES as u64,
        Some(&mut budget),
    ) {
        Ok(r) => r,
        Err(ReferenceProblem::NotFound) => return Ok(None),
        Err(problem) => {
            return Ok(Some(ProjectSnapshot {
                identity,
                config: file_problem(&file, Origin::Project, problem),
                fingerprint: None,
                stamps,
            }));
        }
    };
    if read.resolved != PROJECT_FILE {
        stamps.push(stamp_of(&identity.root.join(&read.resolved)));
    }
    let parsed = parse_config(&read.text, &file, Origin::Project);
    let refs = read_references(&parsed, &identity.root, &mut budget, &mut stamps);
    let ok = parsed.ok;
    let config = resolve_shortcuts(parsed, &refs.reads);
    let fingerprint = (ok && refs.complete).then(|| {
        let pinned = PinnedFile {
            path: PROJECT_FILE.into(),
            resolved: read.resolved,
            links: read.links,
            sha256: read.sha256,
        };
        murmo_store::sha256_hex(trust_manifest(&pinned, &refs.pinned).as_bytes())
    });
    Ok(Some(ProjectSnapshot {
        identity,
        config,
        fingerprint,
        stamps,
    }))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrustState {
    None,
    Approved,
    Review,
    Changed,
    NotApprovable,
}

impl TrustState {
    pub fn name(self) -> &'static str {
        match self {
            TrustState::None => "none",
            TrustState::Approved => "approved",
            TrustState::Review => "review",
            TrustState::Changed => "changed",
            TrustState::NotApprovable => "not-approvable",
        }
    }
}

/// The approval must match the fingerprint, the device and inode, and the root.
pub fn trust_state_of(snapshot: &ProjectSnapshot, approval: Option<&Json>) -> TrustState {
    let Some(fingerprint) = &snapshot.fingerprint else {
        return TrustState::NotApprovable;
    };
    let Some(a) = approval else {
        return TrustState::Review;
    };
    let id = &snapshot.identity;
    let same = a["fingerprint"].as_str() == Some(fingerprint)
        && a["dev"].as_str() == Some(&id.dev)
        && a["ino"].as_str() == Some(&id.ino)
        && a["root"].as_str() == Some(&id.root.to_string_lossy());
    if same {
        TrustState::Approved
    } else {
        TrustState::Changed
    }
}

pub struct SessionConfig {
    pub user: Option<LoadedConfig>,
    pub project: Option<ProjectSnapshot>,
    pub trust: TrustState,
    pub effective: EffectiveConfig,
    pub stamps: Vec<FileStamp>,
}

impl SessionConfig {
    /// The same JSON as the JS `SessionConfig`, without the stamps.
    pub fn to_json(&self) -> Json {
        let mut v = json!({ "trust": self.trust.name(), "effective": self.effective.to_json() });
        if let Some(u) = &self.user {
            v["user"] = u.to_json();
        }
        if let Some(p) = &self.project {
            let mut project = json!({
                "identity": { "projectId": p.identity.project_id, "root": p.identity.root.to_string_lossy(), "dev": p.identity.dev, "ino": p.identity.ino },
                "config": p.config.to_json(),
            });
            if let Some(f) = &p.fingerprint {
                project["fingerprint"] = json!(f);
            }
            v["project"] = project;
        }
        v
    }

    /// True when any file the load depended on changed since.
    pub fn changed(&self) -> bool {
        self.stamps
            .iter()
            .any(|s| stamp_of(&s.path).stamp != s.stamp)
    }
}

pub fn load_session_config(
    cwd: &Path,
    user_path: &Path,
    layout: &StoreLayout,
) -> io::Result<SessionConfig> {
    let (user, mut stamps) = load_user_config(user_path);
    stamps.push(stamp_of(&layout.trust));
    let mut project = None;
    let mut trust = TrustState::None;
    if let Some(root) = find_repository_root(cwd)? {
        project = scan_project(&root)?;
        match &project {
            Some(p) => {
                stamps.extend(p.stamps.iter().cloned());
                let mut repairs = ModeRepairs::default();
                let approval = match read_record(
                    RecordKind::Trust,
                    &layout.trust,
                    RECORD_MAX_BYTES,
                    &mut repairs,
                ) {
                    RecordRead::Ok(r) => r
                        .get("approvals")
                        .and_then(|a| a.get(&p.identity.project_id))
                        .cloned(),
                    _ => None,
                };
                trust = trust_state_of(p, approval.as_ref());
            }
            None => stamps.push(stamp_of(&fs::canonicalize(&root)?.join(PROJECT_FILE))),
        }
    }
    let effective = merge_config(
        user.as_ref(),
        project.as_ref().map(|p| &p.config),
        trust == TrustState::Approved,
    );
    Ok(SessionConfig {
        user,
        project,
        trust,
        effective,
        stamps,
    })
}

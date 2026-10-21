//! The bounded, no-follow reader for project files (port of
//! `src/node/reader.ts`): every check that can refuse a path runs before the
//! file is opened, and the bytes that are hashed are the bytes that load.
//!
//! Like the JS reader it is not proof against a concurrent hostile rename of
//! a parent folder; a handle-rooted `openat` reader is proposed for phase 10.

use std::fs::{self, OpenOptions};
use std::io::{self, Read};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use crate::references::ReferenceProblem;
use crate::schema::reference_path_problem;
use crate::trust::SymlinkHop;

pub struct InsideFile {
    pub text: String,
    pub bytes: u64,
    pub sha256: String,
    /// Repository-relative path after resolving symlinks.
    pub resolved: String,
    pub links: Vec<SymlinkHop>,
}

/// Remaining read allowance of one load.
#[derive(Clone, Copy, Debug)]
pub struct ReadBudget {
    pub bytes: u64,
    pub reads: u32,
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn inside(root: &Path, path: &Path) -> bool {
    path.starts_with(root)
}

fn problem_of(e: &io::Error) -> ReferenceProblem {
    if e.kind() == io::ErrorKind::NotFound || e.raw_os_error() == Some(libc::ENOTDIR) {
        ReferenceProblem::NotFound
    } else {
        ReferenceProblem::Unreadable
    }
}

/// Reads `input` (relative, `/`-separated) inside the canonical `root`, at
/// most `max` bytes.
pub fn read_inside(
    root: &Path,
    input: &str,
    max: u64,
    budget: Option<&mut ReadBudget>,
) -> Result<InsideFile, ReferenceProblem> {
    match reference_path_problem(input) {
        Some("absolute") => return Err(ReferenceProblem::Absolute),
        Some(_) => return Err(ReferenceProblem::Traversal),
        None => {}
    }
    let mut budget = budget;
    if let Some(b) = budget.as_deref_mut() {
        if b.reads == 0 || b.bytes == 0 {
            return Err(ReferenceProblem::Budget);
        }
        b.reads -= 1;
    }
    read(root, input, max, budget).map_err(|e| e.unwrap_or(ReferenceProblem::Unreadable))
}

type Step<T> = Result<T, Option<ReferenceProblem>>;

fn io<T>(r: io::Result<T>) -> Step<T> {
    r.map_err(|e| Some(problem_of(&e)))
}

fn read(root: &Path, input: &str, max: u64, budget: Option<&mut ReadBudget>) -> Step<InsideFile> {
    let mut links = Vec::new();
    let mut component = root.to_path_buf();
    for part in input.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        component.push(part);
        let meta = io(fs::symlink_metadata(&component))?;
        if meta.file_type().is_symlink() {
            let target = io(fs::read_link(&component))?;
            let target = String::from_utf8(target.as_os_str().as_bytes().to_vec())
                .map_err(|_| Some(ReferenceProblem::Unreadable))?;
            links.push(SymlinkHop {
                path: relative(root, &component),
                target,
            });
            if !inside(root, &io(fs::canonicalize(&component))?) {
                return Err(Some(ReferenceProblem::Escapes));
            }
        }
    }
    let resolved: PathBuf = io(fs::canonicalize(&component))?;
    if !inside(root, &resolved) {
        return Err(Some(ReferenceProblem::Escapes));
    }
    let before = io(fs::metadata(&resolved))?;
    if !before.is_file() {
        return Err(Some(ReferenceProblem::NotRegular));
    }
    if before.len() > max {
        return Err(Some(ReferenceProblem::TooLarge));
    }
    if budget.as_deref().is_some_and(|b| before.len() > b.bytes) {
        return Err(Some(ReferenceProblem::Budget));
    }
    let mut file = io(OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&resolved))?;
    let opened = io(file.metadata())?;
    if !opened.is_file() || opened.dev() != before.dev() || opened.ino() != before.ino() {
        return Err(Some(ReferenceProblem::Changed));
    }
    let mut bytes = Vec::new();
    io(Read::take(&mut file, max + 1).read_to_end(&mut bytes))?;
    let used = bytes.len() as u64;
    if used > max {
        return Err(Some(ReferenceProblem::TooLarge));
    }
    let after = io(file.metadata())?;
    let same_time = after.mtime() == opened.mtime() && after.mtime_nsec() == opened.mtime_nsec();
    if used != opened.len()
        || after.len() != opened.len()
        || !same_time
        || io(fs::canonicalize(&component))? != resolved
    {
        return Err(Some(ReferenceProblem::Changed));
    }
    if let Some(b) = budget {
        if used > b.bytes {
            return Err(Some(ReferenceProblem::Budget));
        }
        b.bytes -= used;
    }
    let sha256 = murmo_store::sha256_hex(&bytes);
    let text = String::from_utf8(bytes).map_err(|_| Some(ReferenceProblem::InvalidUtf8))?;
    Ok(InsideFile {
        text,
        bytes: used,
        sha256,
        resolved: relative(root, &resolved),
        links,
    })
}

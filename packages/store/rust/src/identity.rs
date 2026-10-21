//! What a project is (port of `src/node/paths.ts`): its canonical repository
//! root, `projectId = sha256(realpath(root))`, with device and inode kept
//! apart from the display path.

use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use crate::sha256_hex;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectIdentity {
    pub project_id: String,
    pub root: PathBuf,
    /// Decimal, as the JS backend stores them.
    pub dev: String,
    pub ino: String,
}

/// The first directory at or above `start` that holds `.git`.
pub fn find_repository_root(start: &Path) -> io::Result<Option<PathBuf>> {
    let mut dir = fs::canonicalize(start)?;
    loop {
        match fs::symlink_metadata(dir.join(".git")) {
            Ok(_) => return Ok(Some(dir)),
            Err(e)
                if e.kind() == io::ErrorKind::NotFound
                    || e.raw_os_error() == Some(libc::ENOTDIR) => {}
            Err(e) => return Err(e),
        }
        if !dir.pop() {
            return Ok(None);
        }
    }
}

pub fn project_id_of(canonical_root: &Path) -> String {
    sha256_hex(canonical_root.as_os_str().as_encoded_bytes())
}

pub fn project_identity(root: &Path) -> io::Result<ProjectIdentity> {
    let canonical = fs::canonicalize(root)?;
    let meta = fs::metadata(&canonical)?;
    if !meta.is_dir() {
        return Err(io::Error::other(format!(
            "{} is not a directory",
            canonical.display()
        )));
    }
    Ok(ProjectIdentity {
        project_id: project_id_of(&canonical),
        dev: meta.dev().to_string(),
        ino: meta.ino().to_string(),
        root: canonical,
    })
}

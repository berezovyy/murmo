//! One indexer per repo. A lock file with a pid; a dead pid is stolen.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

pub struct IndexLock {
    path: PathBuf,
}

impl IndexLock {
    pub fn acquire(dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let path = dir.join("index.lock");
        if path.exists() {
            if let Ok(text) = fs::read_to_string(&path) {
                if let Ok(pid) = text.trim().parse::<i32>() {
                    // SAFETY: kill(pid, 0) is a liveness probe.
                    let alive = unsafe { libc::kill(pid, 0) == 0 };
                    if alive {
                        return Err("another indexer is running for this project".into());
                    }
                }
            }
            let _ = fs::remove_file(&path);
        }
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| "another indexer is running for this project".to_string())?;
        writeln!(f, "{}", std::process::id()).map_err(|e| e.to_string())?;
        Ok(Self { path })
    }
}

impl Drop for IndexLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

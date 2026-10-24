//! File primitives (port of `src/node/files.ts`): private modes, atomic
//! writes, bounded no-follow reads and stale temp cleanup. Temp names and
//! modes match the Node backend, so either side cleans up after the other.

use std::fs::{self, File, OpenOptions, Permissions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};

pub const DIR_MODE: u32 = 0o700;
pub const FILE_MODE: u32 = 0o600;
/// A temp whose writer is gone, or older than this, is removed on open.
pub const STALE_TEMP: Duration = Duration::from_secs(60 * 60);

/// `.<target><label>.<pid>.<16 hex>.tmp`, beside `target`.
pub fn temp_path(target: &Path, label: &str) -> io::Result<PathBuf> {
    let name = target
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "target has no file name"))?
        .to_string_lossy();
    let file = format!(
        ".{name}{label}.{}.{}.tmp",
        std::process::id(),
        crate::random_hex(8)?
    );
    Ok(target.with_file_name(file))
}

/// The writer PID of a temp name, or None when `name` is not a store temp.
pub fn temp_pid(name: &str) -> Option<u32> {
    let body = name.strip_prefix('.')?.strip_suffix(".tmp")?;
    let (rest, random) = body.rsplit_once('.')?;
    let (target, pid) = rest.rsplit_once('.')?;
    let hex = random.len() == 16
        && random
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if target.is_empty() || !hex || pid.is_empty() || !pid.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    pid.parse().ok()
}

/// True while a process with this PID exists (EPERM: it exists but isn't ours).
pub fn process_alive(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    // SAFETY: kill with signal 0 only checks that the process exists.
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    rc == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Paths whose wider mode was repaired, so the caller can report each once.
#[derive(Default, Debug)]
pub struct ModeRepairs {
    pub repaired: Vec<PathBuf>,
}

fn repair(path: &Path, mode: u32, actual: u32, repairs: &mut ModeRepairs) -> io::Result<()> {
    if actual & 0o777 != mode {
        fs::set_permissions(path, Permissions::from_mode(mode))?;
        repairs.repaired.push(path.to_path_buf());
    }
    Ok(())
}

/// Creates `dir` and its parents; everything from `base` (a Murmo root) down
/// is 0700, and an existing directory with a wider mode is repaired.
pub fn ensure_private_dir(dir: &Path, base: &Path, repairs: &mut ModeRepairs) -> io::Result<()> {
    let rel = dir.strip_prefix(base).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} is outside {}", dir.display(), base.display()),
        )
    })?;
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "directory path is not normal",
        ));
    }
    if let Some(parent) = base.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut current = base.to_path_buf();
    let parts: Vec<_> = rel.components().collect();
    for i in 0..=parts.len() {
        if i > 0 {
            current.push(parts[i - 1]);
        }
        match fs::DirBuilder::new().mode(DIR_MODE).create(&current) {
            Ok(()) => fs::set_permissions(&current, Permissions::from_mode(DIR_MODE))?,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                let meta = fs::symlink_metadata(&current)?;
                if !meta.is_dir() {
                    return Err(io::Error::other(format!(
                        "{} exists and is not a directory",
                        current.display()
                    )));
                }
                repair(&current, DIR_MODE, meta.mode(), repairs)?;
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// Exclusive random sibling temp, every byte written, optional fsync, rename,
/// optional directory fsync.
pub fn write_atomic(target: &Path, data: &[u8], durable: bool) -> io::Result<()> {
    let temp = temp_path(target, "")?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(FILE_MODE)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&temp)?;
        file.set_permissions(Permissions::from_mode(FILE_MODE))?;
        file.write_all(data)?;
        if durable {
            file.sync_all()?;
        }
        drop(file);
        fs::rename(&temp, target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
        return result;
    }
    if durable {
        if let Some(dir) = target.parent() {
            sync_directory(dir)?;
        }
    }
    Ok(())
}

pub fn sync_directory(dir: &Path) -> io::Result<()> {
    File::open(dir)?.sync_all()
}

pub enum BoundedRead {
    Ok(Vec<u8>),
    Missing,
    Unreadable(String),
}

/// Reads a store file through one descriptor: no symlink, a regular file, at
/// most `max` bytes, mode repaired to 0600. O_NONBLOCK keeps a FIFO from hanging.
pub fn read_store_file(path: &Path, max: u64, repairs: &mut ModeRepairs) -> BoundedRead {
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return BoundedRead::Missing,
        Err(e) if e.raw_os_error() == Some(libc::ELOOP) => {
            return BoundedRead::Unreadable("is a symbolic link".into())
        }
        Err(e) => return BoundedRead::Unreadable(e.to_string()),
    };
    let meta = match file.metadata() {
        Ok(m) => m,
        Err(e) => return BoundedRead::Unreadable(e.to_string()),
    };
    if !meta.is_file() {
        return BoundedRead::Unreadable("is not a regular file".into());
    }
    if meta.len() > max {
        return BoundedRead::Unreadable(format!("is larger than {max} bytes"));
    }
    if meta.mode() & 0o777 != FILE_MODE
        && file
            .set_permissions(Permissions::from_mode(FILE_MODE))
            .is_ok()
    {
        repairs.repaired.push(path.to_path_buf());
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    match Read::take(&mut file, max).read_to_end(&mut bytes) {
        Ok(_) => BoundedRead::Ok(bytes),
        Err(e) => BoundedRead::Unreadable(e.to_string()),
    }
}

/// Removes temps in `dir` whose writer is dead or that are older than an hour.
pub fn remove_stale_temps(dir: &Path) -> io::Result<usize> {
    remove_stale_temps_at(dir, crate::now_ms() as f64)
}

/// `remove_stale_temps` with the time given, in Unix milliseconds: draft
/// cleanup passes its `now`, as `removeStaleTemps(dir, now)` does in Node.
pub fn remove_stale_temps_at(dir: &Path, now_ms: f64) -> io::Result<usize> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e),
    };
    let mut removed = 0;
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let Some(pid) = temp_pid(&name.to_string_lossy()) else {
            continue;
        };
        let path = entry.path();
        let stale = !process_alive(pid)
            || fs::symlink_metadata(&path)
                .and_then(|m| m.modified())
                .map(|t| {
                    let mtime_ms = t
                        .duration_since(SystemTime::UNIX_EPOCH)
                        .map(|d| d.as_secs_f64() * 1000.0)
                        .unwrap_or(0.0);
                    now_ms - mtime_ms > STALE_TEMP.as_secs_f64() * 1000.0
                })
                .unwrap_or(false);
        if stale {
            let gone = if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                fs::remove_dir_all(&path)
            } else {
                fs::remove_file(&path)
            };
            if gone.is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_names_match_the_node_backend() {
        // Either backend must recognize the other's temps, or a killed Rust
        // writer's temp would survive a Node open forever (crash test).
        assert_eq!(temp_pid(".trust.json.123.0123456789abcdef.tmp"), Some(123));
        assert_eq!(
            temp_pid(".trust.json.lock.stale.9.0123456789abcdef.tmp"),
            Some(9)
        );
        assert_eq!(temp_pid("trust.json.123.0123456789abcdef.tmp"), None);
        assert_eq!(temp_pid(".trust.json.123.0123456789ABCDEF.tmp"), None);
        let path = temp_path(Path::new("/x/trust.json"), "").unwrap();
        assert_eq!(
            temp_pid(&path.file_name().unwrap().to_string_lossy()),
            Some(std::process::id())
        );
    }
}

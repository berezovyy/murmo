//! The interprocess lock (port of `src/node/lock.ts`, same protocol):
//! `<file>.lock` holds `{"pid","acquiredAt","token"}` and is created whole with
//! link(2). Retry every 10 ms, give up after 2 s with `Busy`, reclaim only a
//! lock whose owner is dead or that is older than 30 s.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use crate::files::{process_alive, temp_path, FILE_MODE};

pub const LOCK_RETRY: Duration = Duration::from_millis(10);
pub const LOCK_TIMEOUT: Duration = Duration::from_secs(2);
pub const LOCK_STALE: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug)]
pub struct LockOptions {
    pub retry: Duration,
    pub timeout: Duration,
    pub stale: Duration,
}

impl Default for LockOptions {
    fn default() -> Self {
        LockOptions {
            retry: LOCK_RETRY,
            timeout: LOCK_TIMEOUT,
            stale: LOCK_STALE,
        }
    }
}

pub enum Locked<T> {
    Ok(T),
    Busy,
}

pub fn lock_path(target: &Path) -> PathBuf {
    let mut name = target.file_name().unwrap_or_default().to_os_string();
    name.push(".lock");
    target.with_file_name(name)
}

/// The held lock: `still_held` is checked right before a commit.
pub struct HeldLock {
    path: PathBuf,
    token: String,
}

impl HeldLock {
    pub fn still_held(&self) -> bool {
        read_lock(&self.path).is_some_and(|c| c.token == self.token)
    }
}

struct LockContent {
    pid: u32,
    acquired_at: u64,
    token: String,
}

fn read_lock(path: &Path) -> Option<LockContent> {
    let text = fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some(LockContent {
        pid: u32::try_from(value.get("pid")?.as_u64()?).ok()?,
        acquired_at: value.get("acquiredAt")?.as_f64()? as u64,
        token: value.get("token")?.as_str()?.to_string(),
    })
}

/// Runs `f` while holding the lock for `target`.
pub fn with_lock<T>(
    target: &Path,
    options: LockOptions,
    f: impl FnOnce(&HeldLock) -> io::Result<T>,
) -> io::Result<Locked<T>> {
    let path = lock_path(target);
    let token = crate::random_hex(16)?;
    if !acquire(&path, &token, options)? {
        return Ok(Locked::Busy);
    }
    let held = HeldLock { path, token };
    let result = f(&held);
    if held.still_held() {
        let _ = fs::remove_file(&held.path);
    }
    result.map(Locked::Ok)
}

fn acquire(path: &Path, token: &str, options: LockOptions) -> io::Result<bool> {
    let deadline = Instant::now() + options.timeout;
    let temp = temp_path(path, "")?;
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(FILE_MODE)
            .open(&temp)?;
        let content = serde_json::json!({ "pid": std::process::id(), "acquiredAt": crate::now_ms(), "token": token });
        writeln!(file, "{content}")?;
    }
    let result = (|| loop {
        match fs::hard_link(&temp, path) {
            Ok(()) => return Ok(true),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
        let (stale, judged) = inspect(path, options.stale);
        if stale {
            reclaim(path, judged.as_deref())?;
            continue;
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        std::thread::sleep(options.retry);
    })();
    let _ = fs::remove_file(&temp);
    result
}

fn inspect(path: &Path, stale: Duration) -> (bool, Option<String>) {
    if let Some(content) = read_lock(path) {
        let age = Duration::from_millis(crate::now_ms().saturating_sub(content.acquired_at));
        return (
            !process_alive(content.pid) || age > stale,
            Some(content.token),
        );
    }
    match fs::symlink_metadata(path).and_then(|m| m.modified()) {
        Ok(modified) => (
            SystemTime::now()
                .duration_since(modified)
                .unwrap_or_default()
                > stale,
            None,
        ),
        Err(_) => (false, None),
    }
}

/// Moves the stale lock aside (one reclaimer wins the rename), then puts back
/// a fresh lock another process took in between.
fn reclaim(path: &Path, judged: Option<&str>) -> io::Result<()> {
    let aside = temp_path(path, ".stale")?;
    match fs::rename(path, &aside) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    }
    if let Some(moved) = read_lock(&aside) {
        if Some(moved.token.as_str()) != judged {
            let _ = fs::hard_link(&aside, path);
        }
    }
    let _ = fs::remove_file(&aside);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("murmo-lock-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_dead_owners_lock_is_reclaimed() {
        // A writer SIGKILLed while holding the lock must not block every later
        // write for 30 s.
        let dir = scratch("dead");
        let target = dir.join("r.json");
        fs::write(
            lock_path(&target),
            r#"{"pid":999999999,"acquiredAt":0,"token":"x"}"#,
        )
        .unwrap();
        let got = with_lock(&target, LockOptions::default(), |_| Ok(7)).unwrap();
        assert!(matches!(got, Locked::Ok(7)));
        assert!(!lock_path(&target).exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_live_lock_gives_busy() {
        // Two writers must never both hold the lock.
        let dir = scratch("live");
        let target = dir.join("r.json");
        let content = format!(
            r#"{{"pid":{},"acquiredAt":{},"token":"x"}}"#,
            std::process::id(),
            crate::now_ms()
        );
        fs::write(lock_path(&target), content).unwrap();
        let options = LockOptions {
            timeout: Duration::from_millis(50),
            ..LockOptions::default()
        };
        let got = with_lock(&target, options, |_| Ok(())).unwrap();
        assert!(matches!(got, Locked::Busy));
        assert!(
            lock_path(&target).exists(),
            "a busy caller must not remove the owner's lock"
        );
        fs::remove_dir_all(dir).unwrap();
    }
}

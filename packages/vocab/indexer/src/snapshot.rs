//! Atomic snapshot-directory swap. Readers open each section once (r6: reopening
//! per chunk mixed generations).

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::packed::{NAMES_BIN, NAMES_CURRENT, NAMES_FILES, NAMES_META};

pub struct Snapshot {
    pub dir: PathBuf,
    pub names: Vec<u8>,
    pub meta: String,
    pub files: String,
}

/// Write a new snapshot and swing CURRENT. `dir` is `.../names-v1/`.
pub fn commit_snapshot(
    dir: &Path,
    names: &[u8],
    meta: &str,
    files: &str,
) -> Result<PathBuf, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let id = format!(
        "snap-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let snap = dir.join(&id);
    fs::create_dir_all(&snap).map_err(|e| e.to_string())?;
    write_file(&snap.join(NAMES_BIN), names)?;
    write_file(&snap.join(NAMES_META), meta.as_bytes())?;
    write_file(&snap.join(NAMES_FILES), files.as_bytes())?;
    let current = dir.join(NAMES_CURRENT);
    let tmp = dir.join("CURRENT.tmp");
    write_file(&tmp, id.as_bytes())?;
    fs::rename(&tmp, &current).map_err(|e| e.to_string())?;
    prune_old(dir, &id);
    Ok(snap)
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut f = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    f.write_all(bytes).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    Ok(())
}

fn prune_old(dir: &Path, keep: &str) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name();
        let Some(s) = name.to_str() else { continue };
        if s.starts_with("snap-") && s != keep {
            let _ = fs::remove_dir_all(e.path());
        }
    }
}

/// Open CURRENT and read each section through one fd (never reopen by path).
pub fn read_current(dir: &Path) -> Result<Snapshot, String> {
    let current_path = dir.join(NAMES_CURRENT);
    let id = fs::read_to_string(&current_path).map_err(|e| e.to_string())?;
    let id = id.trim();
    if id.is_empty() {
        return Err("empty CURRENT".into());
    }
    let snap = dir.join(id);
    let names = read_once(&snap.join(NAMES_BIN))?;
    let meta = String::from_utf8(read_once(&snap.join(NAMES_META))?).map_err(|e| e.to_string())?;
    let files =
        String::from_utf8(read_once(&snap.join(NAMES_FILES))?).map_err(|e| e.to_string())?;
    Ok(Snapshot {
        dir: snap,
        names,
        meta,
        files,
    })
}

fn read_once(path: &Path) -> Result<Vec<u8>, String> {
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    std::io::Read::read_to_end(&mut f, &mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

/// Negative control: reopening the path between chunks can mix generations.
pub fn read_reopen_chunks(path: &Path, chunk: usize) -> Result<Vec<u8>, String> {
    let len = fs::metadata(path).map_err(|e| e.to_string())?.len() as usize;
    let mut out = Vec::with_capacity(len);
    let mut off = 0;
    while off < len {
        let mut f = File::open(path).map_err(|e| e.to_string())?;
        use std::io::{Read, Seek, SeekFrom};
        f.seek(SeekFrom::Start(off as u64))
            .map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; chunk.min(len - off)];
        f.read_exact(&mut buf).map_err(|e| e.to_string())?;
        out.extend_from_slice(&buf);
        off += buf.len();
    }
    Ok(out)
}

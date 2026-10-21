//! Log segments (port of `src/node/logs.ts`): JSON Lines, one segment series
//! per session, rolled at 1 MiB. One writer per session, no lock; a torn last
//! line is skipped by readers and the next append starts on a fresh line.

use std::fs::{self, OpenOptions, Permissions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;

use crate::files::{ensure_private_dir, ModeRepairs, FILE_MODE};
use crate::layout::{check_session_id, StoreLayout};

pub const SEGMENT_BYTES: u64 = 1_048_576;

/// `<session>.<NNNN>.jsonl` → sequence number for `session`.
fn segment_sequence(name: &str, session: &str) -> Option<u64> {
    let rest = name
        .strip_prefix(session)?
        .strip_prefix('.')?
        .strip_suffix(".jsonl")?;
    (rest.len() >= 4 && rest.bytes().all(|b| b.is_ascii_digit()))
        .then(|| rest.parse().ok())
        .flatten()
}

pub struct LogWriter {
    dir: PathBuf,
    base: PathBuf,
    session: String,
    sequence: Option<u64>,
    size: u64,
    needs_newline: bool,
}

impl LogWriter {
    pub fn new(layout: &StoreLayout, kind: &str, session: &str) -> io::Result<Self> {
        let dir = layout.log_directory(kind).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("unknown log kind {kind}"),
            )
        })?;
        if !check_session_id(session) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "session id must be 1-64 letters, digits or \"-\"",
            ));
        }
        Ok(LogWriter {
            dir,
            base: layout.roots.data.clone(),
            session: session.to_string(),
            sequence: None,
            size: 0,
            needs_newline: false,
        })
    }

    fn segment(&self, n: u64) -> PathBuf {
        self.dir.join(format!("{}.{n:04}.jsonl", self.session))
    }

    fn locate(&mut self, repairs: &mut ModeRepairs) -> io::Result<u64> {
        ensure_private_dir(&self.dir, &self.base, repairs)?;
        let mut last = 0;
        for entry in fs::read_dir(&self.dir)? {
            if let Some(n) = segment_sequence(&entry?.file_name().to_string_lossy(), &self.session)
            {
                last = last.max(n);
            }
        }
        let n = last.max(1);
        match fs::File::open(self.segment(n)) {
            Ok(mut file) => {
                self.size = file.metadata()?.len();
                if self.size > 0 {
                    let mut tail = [0u8; 1];
                    file.seek(SeekFrom::Start(self.size - 1))?;
                    file.read_exact(&mut tail)?;
                    self.needs_newline = tail[0] != b'\n';
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => self.size = 0,
            Err(e) => return Err(e),
        }
        Ok(n)
    }

    /// Appends already gated lines (each one JSON object, no newline).
    pub fn append_lines(&mut self, lines: &[String], repairs: &mut ModeRepairs) -> io::Result<u64> {
        if lines.is_empty() {
            return Ok(0);
        }
        let mut sequence = match self.sequence {
            Some(n) => n,
            None => self.locate(repairs)?,
        };
        let body = format!("{}\n", lines.join("\n"));
        let mut data = if self.needs_newline {
            format!("\n{body}")
        } else {
            body.clone()
        };
        if self.size > 0 && self.size + data.len() as u64 > SEGMENT_BYTES {
            sequence += 1;
            self.size = 0;
            data = body;
        }
        self.sequence = Some(sequence);
        let path = self.segment(sequence);
        let mut file = OpenOptions::new()
            .append(true)
            .create(true)
            .mode(FILE_MODE)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)?;
        if file.metadata()?.mode() & 0o777 != FILE_MODE {
            file.set_permissions(Permissions::from_mode(FILE_MODE))?;
            repairs.repaired.push(path.clone());
        }
        file.write_all(data.as_bytes())?;
        self.size += data.len() as u64;
        self.needs_newline = false;
        Ok(data.len() as u64)
    }
}

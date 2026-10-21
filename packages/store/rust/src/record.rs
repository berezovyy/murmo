//! Record files (port of `src/node/record.ts`): read without a lock, update
//! as lock, re-read, apply, temp + rename.

use std::io;
use std::path::Path;

use serde_json::{Map, Value};

use crate::files::{ensure_private_dir, read_store_file, write_atomic, BoundedRead, ModeRepairs};
use crate::lock::{with_lock, LockOptions, Locked};
use crate::records::{decode_record, encode_record, RecordKind, RECORD_MAX_BYTES};

pub enum RecordRead {
    Ok(Map<String, Value>),
    Missing,
    Unreadable(String),
}

pub fn read_record(
    kind: RecordKind,
    path: &Path,
    max: u64,
    repairs: &mut ModeRepairs,
) -> RecordRead {
    match read_store_file(path, max, repairs) {
        BoundedRead::Missing => RecordRead::Missing,
        BoundedRead::Unreadable(reason) => RecordRead::Unreadable(reason),
        BoundedRead::Ok(bytes) => match String::from_utf8(bytes) {
            Err(_) => RecordRead::Unreadable("is not UTF-8".into()),
            Ok(text) => match decode_record(kind, &text) {
                Some(record) => RecordRead::Ok(record),
                None => RecordRead::Unreadable(format!("is not a {} record", kind.name())),
            },
        },
    }
}

/// What an update decided: a new record and the caller's result, or no change.
pub enum Change<R> {
    Write(Map<String, Value>, R),
    Unchanged(R),
}

pub enum Updated<R> {
    Ok {
        result: R,
        written: bool,
        reset: bool,
    },
    Busy,
    Error(String),
}

pub struct UpdateOptions<'a> {
    /// The Murmo root the record lives under.
    pub base: &'a Path,
    pub durable: bool,
    pub max_bytes: u64,
    pub lock: LockOptions,
}

impl<'a> UpdateOptions<'a> {
    pub fn new(base: &'a Path) -> Self {
        UpdateOptions {
            base,
            durable: false,
            max_bytes: RECORD_MAX_BYTES,
            lock: LockOptions::default(),
        }
    }
}

/// Applies `update` to the current record under its lock. An unreadable record
/// is passed as None and replaced; `reset` says so.
pub fn update_record<R>(
    kind: RecordKind,
    path: &Path,
    options: &UpdateOptions,
    repairs: &mut ModeRepairs,
    update: impl FnOnce(Option<Map<String, Value>>) -> Change<R>,
) -> Updated<R> {
    let run = || -> io::Result<Locked<Updated<R>>> {
        let dir = path
            .parent()
            .ok_or_else(|| io::Error::other("record path has no folder"))?;
        ensure_private_dir(dir, options.base, repairs)?;
        with_lock(path, options.lock, |held| {
            let current = read_record(kind, path, options.max_bytes, repairs);
            let reset = matches!(current, RecordRead::Unreadable(_));
            let change = update(match current {
                RecordRead::Ok(r) => Some(r),
                _ => None,
            });
            match change {
                Change::Unchanged(result) => Ok(Updated::Ok {
                    result,
                    written: false,
                    reset,
                }),
                Change::Write(record, result) => {
                    let text = encode_record(&record);
                    if text.len() as u64 > options.max_bytes {
                        return Ok(Updated::Error(format!(
                            "record would exceed {} bytes",
                            options.max_bytes
                        )));
                    }
                    if !held.still_held() {
                        return Ok(Updated::Busy);
                    }
                    write_atomic(path, text.as_bytes(), options.durable)?;
                    Ok(Updated::Ok {
                        result,
                        written: true,
                        reset,
                    })
                }
            }
        })
    };
    match run() {
        Ok(Locked::Ok(updated)) => updated,
        Ok(Locked::Busy) => Updated::Busy,
        Err(e) => Updated::Error(e.to_string()),
    }
}

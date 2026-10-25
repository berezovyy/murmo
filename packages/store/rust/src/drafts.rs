//! Draft rescue files (port of `src/draft.ts` and `src/node/drafts.ts`):
//! DRAFT-FORMAT v1 under `<state>/drafts/v1/<project>/<host>/<session>.draft`,
//! written whole (exclusive 0600 temp + rename), with the session's liveness
//! lock `<session>.lock` beside it. A snapshot is offered only when its owner
//! is gone. Claude sessions reach these through the helper, which holds their
//! lock and exits with the session; the lock body and start token match the
//! Node backend so either side can judge the other's lock. Messages match the
//! JS backend word for word.

use std::collections::HashMap;
use std::fs::{self, OpenOptions, Permissions};
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::files::{
    ensure_private_dir, process_alive, read_store_file, remove_stale_temps_at, write_atomic,
    BoundedRead, ModeRepairs, FILE_MODE,
};
use crate::layout::{check_project_id, check_session_id, StoreLayout};

/// Maximum UTF-8 bytes of draft text. The envelope may add at most 1 KiB.
pub const DRAFT_MAX_TEXT_BYTES: usize = 65_536;
/// JSON header line, including the trailing newline.
pub const DRAFT_MAX_HEADER_BYTES: usize = 1024;
/// 24 hours from capture.
pub const DRAFT_TTL_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
/// Hosts a draft file may name (`DRAFT_HOSTS` in `src/layout.ts`).
pub const DRAFT_HOSTS: [&str; 5] = ["claude", "codex", "opencode", "pi", "fake"];

const FILE_MAX: u64 = (DRAFT_MAX_TEXT_BYTES + DRAFT_MAX_HEADER_BYTES) as u64;
const PROJECT_ID_PROBLEM: &str = "project id must be 64 lowercase hex digits";
const SESSION_ID_PROBLEM: &str = "session id must be 1-64 letters, digits or \"-\"";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DraftId {
    pub project: String,
    pub host: String,
    pub session: String,
}

pub fn check_draft_host(host: &str) -> Result<&str, String> {
    if DRAFT_HOSTS.contains(&host) {
        Ok(host)
    } else {
        Err(format!("unknown draft host {host}"))
    }
}

/// `checkDraftIdentity`: project, then host, then session.
pub fn check_draft_identity(project: &str, host: &str, session: &str) -> Result<DraftId, String> {
    if !check_project_id(project) {
        return Err(PROJECT_ID_PROBLEM.into());
    }
    check_draft_host(host)?;
    if !check_session_id(session) {
        return Err(SESSION_ID_PROBLEM.into());
    }
    Ok(DraftId {
        project: project.into(),
        host: host.into(),
        session: session.into(),
    })
}

/// A JS number as JSON: integral values print without a fraction, as `JSON.stringify` does.
fn num(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() < 9_007_199_254_740_992.0 {
        json!(x as i64)
    } else {
        json!(x)
    }
}

fn is_integer(x: f64) -> bool {
    x.is_finite() && x.fract() == 0.0
}

#[derive(Clone, Debug, PartialEq)]
pub struct DraftHeader {
    pub id: DraftId,
    pub revision: f64,
    pub cursor_utf16: f64,
    pub captured_at: f64,
    pub expires_at: f64,
    pub text_bytes: usize,
    pub attempted: bool,
}

impl DraftHeader {
    /// The header as `src/draft.ts` builds it, in the same key order.
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("version".into(), json!(1));
        m.insert("project".into(), json!(self.id.project));
        m.insert("host".into(), json!(self.id.host));
        m.insert("session".into(), json!(self.id.session));
        m.insert("revision".into(), num(self.revision));
        m.insert("cursorUTF16".into(), num(self.cursor_utf16));
        m.insert("capturedAt".into(), num(self.captured_at));
        m.insert("expiresAt".into(), num(self.expires_at));
        m.insert("textBytes".into(), json!(self.text_bytes));
        if self.attempted {
            m.insert("attempted".into(), json!(true));
        }
        Value::Object(m)
    }

    /// `JSON.stringify(header)`: the key order of the JS writer (serde_json's map sorts keys).
    fn json_line(&self) -> String {
        let mut line = format!(
            "{{\"version\":1,\"project\":\"{}\",\"host\":\"{}\",\"session\":\"{}\",\"revision\":{},\"cursorUTF16\":{},\"capturedAt\":{},\"expiresAt\":{},\"textBytes\":{}",
            self.id.project,
            self.id.host,
            self.id.session,
            num(self.revision),
            num(self.cursor_utf16),
            num(self.captured_at),
            num(self.expires_at),
            self.text_bytes
        );
        if self.attempted {
            line.push_str(",\"attempted\":true");
        }
        line.push_str("}\n");
        line
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DraftDocument {
    pub header: DraftHeader,
    pub text: String,
}

impl DraftDocument {
    pub fn to_value(&self) -> Value {
        json!({ "header": self.header.to_value(), "text": self.text })
    }

    fn offerable(&self, now: f64) -> bool {
        !self.header.attempted && self.header.expires_at > now && !self.text.is_empty()
    }

    fn expired(&self, now: f64) -> bool {
        self.header.expires_at <= now
    }
}

/// `isUtf16Boundary`: a whole UTF-16 offset inside the text that does not split a surrogate pair.
pub fn utf16_boundary(text: &str, at: f64) -> bool {
    if !is_integer(at) || at < 0.0 {
        return false;
    }
    let mut units = 0f64;
    for c in text.chars() {
        if units == at {
            return true;
        }
        units += c.len_utf16() as f64;
        if units > at {
            return false;
        }
    }
    units == at
}

fn header(
    id: &DraftId,
    revision: f64,
    cursor_utf16: f64,
    captured_at: f64,
    text_bytes: usize,
    attempted: bool,
) -> Result<DraftHeader, String> {
    if !is_integer(revision) || revision < 0.0 {
        return Err("draft revision must be a whole number".into());
    }
    if !captured_at.is_finite() {
        return Err("draft capturedAt must be a finite time".into());
    }
    if text_bytes > DRAFT_MAX_TEXT_BYTES {
        return Err("draft textBytes is out of range".into());
    }
    Ok(DraftHeader {
        id: id.clone(),
        revision,
        cursor_utf16,
        captured_at,
        expires_at: captured_at + DRAFT_TTL_MS,
        text_bytes,
        attempted,
    })
}

/// `encodeDraft`: refuses an oversize header or text, or a cursor inside a character.
pub fn encode_draft(header: &DraftHeader, text: &str) -> Result<Vec<u8>, String> {
    if text.len() > DRAFT_MAX_TEXT_BYTES {
        return Err("draft text is larger than 64 KiB".into());
    }
    if header.text_bytes != text.len() {
        return Err("draft textBytes does not match the text".into());
    }
    if !utf16_boundary(text, header.cursor_utf16) {
        return Err("draft cursor is not a UTF-16 character boundary".into());
    }
    let line = header.json_line();
    if line.len() > DRAFT_MAX_HEADER_BYTES {
        return Err("draft header is larger than 1 KiB".into());
    }
    let mut out = Vec::with_capacity(line.len() + text.len());
    out.extend_from_slice(line.as_bytes());
    out.extend_from_slice(text.as_bytes());
    Ok(out)
}

fn as_header(value: &Value) -> Option<DraftHeader> {
    let v = value.as_object()?;
    if v.get("version")?.as_f64()? != 1.0 {
        return None;
    }
    let (project, host, session) = (
        v.get("project")?.as_str()?,
        v.get("host")?.as_str()?,
        v.get("session")?.as_str()?,
    );
    let revision = v.get("revision")?.as_f64()?;
    let cursor = v.get("cursorUTF16")?.as_f64()?;
    let captured_at = v.get("capturedAt")?.as_f64()?;
    let expires_at = v.get("expiresAt")?.as_f64()?;
    let text_bytes = v.get("textBytes")?.as_f64()?;
    if !is_integer(revision) || revision < 0.0 || !is_integer(cursor) {
        return None;
    }
    if !is_integer(text_bytes) || !(0.0..=DRAFT_MAX_TEXT_BYTES as f64).contains(&text_bytes) {
        return None;
    }
    let attempted = match v.get("attempted") {
        None => false,
        Some(Value::Bool(true)) => true,
        Some(_) => return None,
    };
    let id = check_draft_identity(project, host, session).ok()?;
    Some(DraftHeader {
        id,
        revision,
        cursor_utf16: cursor,
        captured_at,
        expires_at,
        text_bytes: text_bytes as usize,
        attempted,
    })
}

/// `decodeDraft`. Does not apply expiry; the reader does, so an expired file
/// can be unlinked instead of offered.
pub fn decode_draft(bytes: &[u8]) -> Option<DraftDocument> {
    if bytes.len() > DRAFT_MAX_TEXT_BYTES + DRAFT_MAX_HEADER_BYTES {
        return None;
    }
    let limit = bytes.len().min(DRAFT_MAX_HEADER_BYTES);
    let boundary = bytes[..limit].iter().position(|&b| b == b'\n')?;
    let head = std::str::from_utf8(&bytes[..boundary]).ok()?;
    let header = as_header(&serde_json::from_str::<Value>(head).ok()?)?;
    let body = &bytes[boundary + 1..];
    if body.len() != header.text_bytes {
        return None;
    }
    let text = std::str::from_utf8(body).ok()?.to_string();
    if !utf16_boundary(&text, header.cursor_utf16) {
        return None;
    }
    if header.expires_at <= header.captured_at
        || header.expires_at > header.captured_at + DRAFT_TTL_MS
    {
        return None;
    }
    Some(DraftDocument { header, text })
}

pub struct DraftWrite<'a> {
    pub text: &'a str,
    pub cursor_utf16: f64,
    pub revision: f64,
    pub now: Option<f64>,
    pub attempted: bool,
}

/// `DraftSaveResult`.
#[derive(Debug, PartialEq, Eq)]
pub enum DraftSave {
    Ok,
    Denied(&'static str),
    Error(String),
}

struct LockBody {
    pid: f64,
    start: String,
    token: String,
}

/// The process start time in the Node backend's format (`startToken` in
/// `src/node/drafts.ts`): Linux `l:<starttime ticks>`, macOS `d:<start ms>`
/// at second precision, which is what `Date.parse` of `ps -o lstart` gives.
pub fn start_token(pid: u32) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let raw = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let close = raw.rfind(')')?;
        let ticks = raw.get(close + 2..)?.split(' ').nth(19)?;
        Some(format!("l:{ticks}"))
    }
    #[cfg(target_os = "macos")]
    {
        let pid = libc::c_int::try_from(pid).ok()?;
        // SAFETY: an all-zero proc_bsdinfo is a valid value of this plain C struct.
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        // SAFETY: the buffer is a proc_bsdinfo of `size` bytes, the flavor's result type.
        let got = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut info as *mut libc::proc_bsdinfo).cast(),
                size,
            )
        };
        (got == size).then(|| format!("d:{}", info.pbi_start_tvsec * 1000))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        None
    }
}

fn read_lock(path: &Path) -> Option<LockBody> {
    let value: Value = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    value.get("acquiredAt")?.as_f64()?;
    Some(LockBody {
        pid: value.get("pid")?.as_f64()?,
        start: value.get("start")?.as_str()?.to_string(),
        token: value.get("token")?.as_str()?.to_string(),
    })
}

fn lock_stale(body: Option<&LockBody>) -> bool {
    let Some(body) = body else {
        return true;
    };
    let pid = body.pid;
    if !is_integer(pid) || pid <= 0.0 || pid > u32::MAX as f64 || !process_alive(pid as u32) {
        return true;
    }
    match start_token(pid as u32) {
        Some(now) => !body.start.is_empty() && now != body.start,
        None => false,
    }
}

fn exists(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

fn unlink(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

fn session_of_draft_name(name: &str) -> Option<&str> {
    let session = name.strip_suffix(".draft")?;
    check_session_id(session).then_some(session)
}

fn read_names(dir: &Path) -> io::Result<Option<Vec<String>>> {
    match fs::read_dir(dir) {
        Ok(entries) => Ok(Some(
            entries
                .map(|e| e.map(|e| e.file_name().to_string_lossy().into_owned()))
                .collect::<io::Result<_>>()?,
        )),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn io_err(e: io::Error) -> String {
    e.to_string()
}

/// The drafts kind of one store, with the session locks this process holds.
#[derive(Default)]
pub struct Drafts {
    /// Lock path to the token this process wrote there.
    held: HashMap<PathBuf, String>,
}

impl Drafts {
    fn dir(layout: &StoreLayout, id: &DraftId) -> PathBuf {
        layout.drafts.join(&id.project).join(&id.host)
    }

    fn file(layout: &StoreLayout, id: &DraftId) -> PathBuf {
        Self::dir(layout, id).join(format!("{}.draft", id.session))
    }

    fn lock(layout: &StoreLayout, id: &DraftId) -> PathBuf {
        Self::dir(layout, id).join(format!("{}.lock", id.session))
    }

    fn read_document(path: &Path, repairs: &mut ModeRepairs) -> Option<DraftDocument> {
        match read_store_file(path, FILE_MAX, repairs) {
            BoundedRead::Ok(bytes) => decode_draft(&bytes),
            _ => None,
        }
    }

    fn live_lock(&self, path: &Path) -> io::Result<bool> {
        if self.held.contains_key(path) {
            return Ok(true);
        }
        if !exists(path)? {
            return Ok(false);
        }
        Ok(!lock_stale(read_lock(path).as_ref()))
    }

    /// Removes the drafts of this project and host whose session is gone.
    fn sweep_dead(&self, layout: &StoreLayout, id: &DraftId) -> io::Result<()> {
        let Some(names) = read_names(&Self::dir(layout, id))? else {
            return Ok(());
        };
        for name in names {
            let Some(session) = session_of_draft_name(&name) else {
                continue;
            };
            if session == id.session {
                continue;
            }
            let other = DraftId {
                session: session.into(),
                ..id.clone()
            };
            if self.live_lock(&Self::lock(layout, &other))? {
                continue;
            }
            unlink(&Self::file(layout, &other))?;
            unlink(&Self::lock(layout, &other))?;
        }
        Ok(())
    }

    pub fn save(
        &mut self,
        layout: &StoreLayout,
        repairs: &mut ModeRepairs,
        private: bool,
        id: (&str, &str, &str),
        write: &DraftWrite,
    ) -> Result<DraftSave, String> {
        if private {
            let identity = check_draft_identity(id.0, id.1, id.2)?;
            unlink(&Self::file(layout, &identity)).map_err(io_err)?;
            return Ok(DraftSave::Denied("private mode"));
        }
        if write.text.is_empty() {
            return Ok(DraftSave::Denied("empty"));
        }
        let now = write.now.unwrap_or_else(|| crate::now_ms() as f64);
        let identity = check_draft_identity(id.0, id.1, id.2)?;
        if write.text.len() > DRAFT_MAX_TEXT_BYTES {
            unlink(&Self::file(layout, &identity)).map_err(io_err)?;
            return Ok(DraftSave::Denied("oversize"));
        }
        let written = (|| -> Result<(), String> {
            let header = header(
                &identity,
                write.revision,
                write.cursor_utf16,
                now,
                write.text.len(),
                write.attempted,
            )?;
            let bytes = encode_draft(&header, write.text)?;
            let target = Self::file(layout, &identity);
            ensure_private_dir(&Self::dir(layout, &identity), &layout.roots.state, repairs)
                .map_err(io_err)?;
            write_atomic(&target, &bytes, false).map_err(io_err)?;
            self.sweep_dead(layout, &identity).map_err(io_err)
        })();
        Ok(match written {
            Ok(()) => DraftSave::Ok,
            Err(reason) => DraftSave::Error(reason),
        })
    }

    pub fn read(
        &self,
        layout: &StoreLayout,
        repairs: &mut ModeRepairs,
        id: (&str, &str, &str),
    ) -> Result<Option<DraftDocument>, String> {
        let identity = check_draft_identity(id.0, id.1, id.2)?;
        Ok(Self::read_document(&Self::file(layout, &identity), repairs))
    }

    pub fn delete(&self, layout: &StoreLayout, id: (&str, &str, &str)) -> Result<(), String> {
        let identity = check_draft_identity(id.0, id.1, id.2)?;
        unlink(&Self::file(layout, &identity)).map_err(io_err)
    }

    pub fn mark_attempted(
        &self,
        layout: &StoreLayout,
        repairs: &mut ModeRepairs,
        id: (&str, &str, &str),
        now: Option<f64>,
    ) -> Result<(), String> {
        let identity = check_draft_identity(id.0, id.1, id.2)?;
        let path = Self::file(layout, &identity);
        let Some(document) = Self::read_document(&path, repairs) else {
            return Ok(());
        };
        let captured_at = now.unwrap_or(document.header.captured_at);
        let header = header(
            &identity,
            document.header.revision,
            document.header.cursor_utf16,
            captured_at,
            document.header.text_bytes,
            true,
        )?;
        let bytes = encode_draft(&header, &document.text)?;
        ensure_private_dir(&Self::dir(layout, &identity), &layout.roots.state, repairs)
            .map_err(io_err)?;
        write_atomic(&path, &bytes, false).map_err(io_err)
    }

    /// Takes this session's liveness lock: `<session>.lock` with pid, start
    /// token, time and token, created with O_EXCL.
    ///
    /// The owner written is this process's parent: the helper serves exactly
    /// one Claude session and the adapter restarts it after a crash, so a lock
    /// in the helper's own pid would go stale (and the running session's draft
    /// become offerable) on a helper restart. The Claude process lives exactly
    /// as long as the session. A live lock of that same parent is ours, taken
    /// over like Node's same-pid case.
    pub fn hold_lock(
        &mut self,
        layout: &StoreLayout,
        repairs: &mut ModeRepairs,
        id: (&str, &str, &str),
    ) -> Result<(), String> {
        let identity = check_draft_identity(id.0, id.1, id.2)?;
        let path = Self::lock(layout, &identity);
        if self.held.contains_key(&path) {
            return Ok(());
        }
        ensure_private_dir(&Self::dir(layout, &identity), &layout.roots.state, repairs)
            .map_err(io_err)?;
        let owner = std::os::unix::process::parent_id();
        let token = format!(
            "{owner}.{}.{}",
            crate::random_hex(8).map_err(io_err)?,
            crate::now_ms()
        );
        let body = json!({
            "pid": owner,
            "start": start_token(owner).unwrap_or_default(),
            "acquiredAt": crate::now_ms(),
            "token": token,
        });
        for _ in 0..3 {
            match write_lock(&path, &body) {
                Ok(()) => {
                    self.held.insert(path, token);
                    return Ok(());
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e.to_string()),
            }
            let current = read_lock(&path);
            if !lock_stale(current.as_ref()) {
                if let Some(current) = current.filter(|c| c.pid == owner as f64) {
                    self.held.insert(path, current.token);
                    return Ok(());
                }
                return Err(format!(
                    "draft session {} is still running",
                    identity.session
                ));
            }
            unlink(&path).map_err(io_err)?;
        }
        Err("could not take the draft session lock".into())
    }

    /// Releases this session's lock: one this process holds, or one a crashed
    /// earlier helper of the same parent left (see `hold_lock`). Another
    /// owner's lock is left alone.
    pub fn release_lock(
        &mut self,
        layout: &StoreLayout,
        id: (&str, &str, &str),
    ) -> Result<(), String> {
        let identity = check_draft_identity(id.0, id.1, id.2)?;
        let path = Self::lock(layout, &identity);
        let current = read_lock(&path);
        let ours = match self.held.remove(&path) {
            Some(token) => current.is_some_and(|c| c.token == token),
            None => current.is_some_and(|c| c.pid == std::os::unix::process::parent_id() as f64),
        };
        if ours {
            unlink(&path).map_err(io_err)?;
        }
        Ok(())
    }

    /// The newest offerable snapshot of a dead session of this project and host.
    pub fn find_offerable(
        &self,
        layout: &StoreLayout,
        repairs: &mut ModeRepairs,
        project: &str,
        host: &str,
        session: Option<&str>,
        now: Option<f64>,
    ) -> Result<Option<DraftDocument>, String> {
        if !check_project_id(project) {
            return Err(PROJECT_ID_PROBLEM.into());
        }
        check_draft_host(host)?;
        let now = now.unwrap_or_else(|| crate::now_ms() as f64);
        let dir = layout.drafts.join(project).join(host);
        let Some(names) = read_names(&dir).map_err(io_err)? else {
            return Ok(None);
        };
        let mut best: Option<DraftDocument> = None;
        for name in names {
            let Some(other) = session_of_draft_name(&name) else {
                continue;
            };
            if session == Some(other) {
                continue;
            }
            let id = DraftId {
                project: project.into(),
                host: host.into(),
                session: other.into(),
            };
            if self.live_lock(&Self::lock(layout, &id)).map_err(io_err)? {
                continue;
            }
            let Some(document) = Self::read_document(&dir.join(&name), repairs) else {
                continue;
            };
            if !document.offerable(now)
                || document.header.id.project != project
                || document.header.id.host != host
            {
                continue;
            }
            if best
                .as_ref()
                .is_none_or(|b| document.header.captured_at > b.header.captured_at)
            {
                best = Some(document);
            }
        }
        Ok(best)
    }

    /// Removes expired or unreadable snapshots, stale temps, and dead locks
    /// without a snapshot, under every project and host.
    pub fn cleanup(
        &self,
        layout: &StoreLayout,
        repairs: &mut ModeRepairs,
        now: Option<f64>,
    ) -> Result<usize, String> {
        let at = now.unwrap_or_else(|| crate::now_ms() as f64);
        let mut removed = 0;
        walk(&layout.drafts, at, repairs, &mut removed).map_err(io_err)?;
        Ok(removed)
    }
}

fn write_lock(path: &Path, body: &Value) -> io::Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(FILE_MODE)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    file.set_permissions(Permissions::from_mode(FILE_MODE))?;
    writeln!(file, "{body}")
}

fn walk(dir: &Path, at: f64, repairs: &mut ModeRepairs, removed: &mut usize) -> io::Result<()> {
    let entries: Vec<fs::DirEntry> = match fs::read_dir(dir) {
        Ok(e) => e.collect::<io::Result<_>>()?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    *removed += remove_stale_temps_at(dir, at)?;
    for entry in entries {
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            walk(&path, at, repairs, removed)?;
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(stem) = name.strip_suffix(".draft") {
            let drop = match read_store_file(&path, FILE_MAX, repairs) {
                BoundedRead::Ok(bytes) => decode_draft(&bytes).is_none_or(|d| d.expired(at)),
                _ => true,
            };
            if drop {
                unlink(&path)?;
                unlink(&path.with_file_name(format!("{stem}.lock")))?;
                *removed += 1;
            }
        } else if let Some(stem) = name.strip_suffix(".lock") {
            let draft = path.with_file_name(format!("{stem}.draft"));
            if lock_stale(read_lock(&path).as_ref()) && !exists(&draft)? {
                unlink(&path)?;
                *removed += 1;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cursor_inside_an_astral_character_is_refused() {
        // The cursor is in UTF-16 units: offset 1 of an emoji splits its
        // surrogate pair, and a restored draft would put the caret inside it.
        assert!(utf16_boundary("😀a", 0.0));
        assert!(!utf16_boundary("😀a", 1.0));
        assert!(utf16_boundary("😀a", 2.0));
        assert!(utf16_boundary("😀a", 3.0));
        assert!(!utf16_boundary("😀a", 4.0));
        assert!(!utf16_boundary("a", 0.5));
    }

    #[test]
    fn cleanup_ages_temps_by_the_time_it_is_given() {
        // Cleanup took the real clock for temps while drafts used `now`, so a
        // test (or the parity check) could not age a live writer's temp.
        let dir = std::env::temp_dir().join(format!("murmo-drafts-temps-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let temp = crate::files::temp_path(&dir.join("x.draft"), "").unwrap();
        fs::write(&temp, b"partial").unwrap();
        let written = crate::now_ms() as f64;
        assert_eq!(
            remove_stale_temps_at(&dir, written + 60_000.0).unwrap(),
            0,
            "a live writer's fresh temp stays"
        );
        assert!(temp.exists());
        assert_eq!(
            remove_stale_temps_at(&dir, written + 2.0 * 3_600_000.0).unwrap(),
            1,
            "an hour-old temp goes"
        );
        assert!(!temp.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn this_process_start_token_is_known() {
        // Without it a lock left by a dead helper whose PID was reused would
        // read as live, and the crash draft would never be offered.
        let token = start_token(std::process::id());
        if cfg!(any(target_os = "linux", target_os = "macos")) {
            assert!(token.is_some_and(|t| t.len() > 2));
        }
    }
}

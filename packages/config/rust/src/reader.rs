//! The bounded, handle-rooted `openat` reader for project files (port of
//! `src/node/reader.ts`). Opening from the root directory fd means a
//! concurrent rename of a parent of `root` cannot point the walk at a
//! different tree (phase 10 hand-off from 14).

use std::ffi::CString;
use std::fs::{self, File};
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

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

fn c_name(part: &str) -> Step<CString> {
    CString::new(part).map_err(|_| Some(ReferenceProblem::Unreadable))
}

fn openat(dir: &OwnedFd, name: &CString, flags: i32) -> io::Result<OwnedFd> {
    let fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }
}

fn fstatat(dir: &OwnedFd, name: &CString) -> io::Result<libc::stat> {
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    let rc = unsafe {
        libc::fstatat(
            dir.as_raw_fd(),
            name.as_ptr(),
            &mut st,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if rc == 0 {
        Ok(st)
    } else {
        Err(io::Error::last_os_error())
    }
}

fn readlinkat(dir: &OwnedFd, name: &CString) -> io::Result<Vec<u8>> {
    let mut buf = vec![0u8; 4096];
    let n = unsafe {
        libc::readlinkat(
            dir.as_raw_fd(),
            name.as_ptr(),
            buf.as_mut_ptr() as *mut _,
            buf.len(),
        )
    };
    if n < 0 {
        Err(io::Error::last_os_error())
    } else {
        buf.truncate(n as usize);
        Ok(buf)
    }
}

fn is_link(st: &libc::stat) -> bool {
    st.st_mode & libc::S_IFMT == libc::S_IFLNK
}

fn is_dir(st: &libc::stat) -> bool {
    st.st_mode & libc::S_IFMT == libc::S_IFDIR
}

fn is_reg(st: &libc::stat) -> bool {
    st.st_mode & libc::S_IFMT == libc::S_IFREG
}

fn read(root: &Path, input: &str, max: u64, budget: Option<&mut ReadBudget>) -> Step<InsideFile> {
    let root_dir = io(open_root(root))?;
    let mut links = Vec::new();
    let mut logical: Vec<String> = Vec::new();
    let mut dir = root_dir;
    let parts: Vec<&str> = input
        .split('/')
        .filter(|p| !p.is_empty() && *p != ".")
        .collect();
    if parts.is_empty() {
        return Err(Some(ReferenceProblem::NotRegular));
    }
    for (i, part) in parts.iter().enumerate() {
        let last = i + 1 == parts.len();
        let name = c_name(part)?;
        let st = io(fstatat(&dir, &name))?;
        if is_link(&st) {
            let raw = io(readlinkat(&dir, &name))?;
            let target = String::from_utf8(raw).map_err(|_| Some(ReferenceProblem::Unreadable))?;
            logical.push((*part).to_string());
            links.push(SymlinkHop {
                path: logical.join("/"),
                target: target.clone(),
            });
            let followed = follow_link(root, &dir, &logical, &target)?;
            dir = followed.dir;
            logical = followed.logical;
            if last {
                return finish_file(dir, max, budget, logical, links);
            }
            continue;
        }
        if last {
            if !is_reg(&st) {
                return Err(Some(ReferenceProblem::NotRegular));
            }
            if st.st_size as u64 > max {
                return Err(Some(ReferenceProblem::TooLarge));
            }
            if budget
                .as_deref()
                .is_some_and(|b| st.st_size as u64 > b.bytes)
            {
                return Err(Some(ReferenceProblem::Budget));
            }
            let flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK;
            let fd = io(openat(&dir, &name, flags))?;
            logical.push((*part).to_string());
            return finish_opened(fd, st, max, budget, logical, links);
        }
        if !is_dir(&st) {
            return Err(Some(ReferenceProblem::NotFound));
        }
        let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW;
        dir = io(openat(&dir, &name, flags))?;
        logical.push((*part).to_string());
    }
    Err(Some(ReferenceProblem::NotFound))
}

struct Followed {
    dir: OwnedFd,
    logical: Vec<String>,
}

fn follow_link(root: &Path, dir: &OwnedFd, logical: &[String], target: &str) -> Step<Followed> {
    if Path::new(target).is_absolute() {
        let resolved = io(fs::canonicalize(target))?;
        if !inside(root, &resolved) {
            return Err(Some(ReferenceProblem::Escapes));
        }
        let rel = relative(root, &resolved);
        let mut cur = io(open_root(root))?;
        let mut log = Vec::new();
        let parts: Vec<&str> = rel
            .split('/')
            .filter(|p| !p.is_empty() && *p != ".")
            .collect();
        if parts.is_empty() {
            return Ok(Followed {
                dir: cur,
                logical: log,
            });
        }
        for (i, part) in parts.iter().enumerate() {
            let last = i + 1 == parts.len();
            let name = c_name(part)?;
            if last {
                return Ok(Followed {
                    dir: cur,
                    logical: {
                        log.push((*part).to_string());
                        log
                    },
                });
            }
            let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW;
            cur = io(openat(&cur, &name, flags))?;
            log.push((*part).to_string());
        }
        return Ok(Followed {
            dir: cur,
            logical: log,
        });
    }
    let mut cur = dup(dir)?;
    let mut log = logical.to_vec();
    if let Some(last) = log.last() {
        if last != ".." {
            log.pop();
        }
    }
    for part in target.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            if log.is_empty() {
                return Err(Some(ReferenceProblem::Escapes));
            }
            log.pop();
            let name = c_name("..")?;
            cur = io(openat(
                &cur,
                &name,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            ))?;
            continue;
        }
        let name = c_name(part)?;
        let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW;
        match openat(&cur, &name, flags) {
            Ok(next) => {
                cur = next;
                log.push(part.to_string());
            }
            Err(_) => {
                log.push(part.to_string());
                return Ok(Followed {
                    dir: cur,
                    logical: log,
                });
            }
        }
    }
    Ok(Followed {
        dir: cur,
        logical: log,
    })
}

fn open_root(root: &Path) -> io::Result<OwnedFd> {
    let c = CString::new(root.as_os_str().as_bytes())
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    let fd = unsafe {
        libc::open(
            c.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }
}

fn dup(fd: &OwnedFd) -> Step<OwnedFd> {
    let n = unsafe { libc::dup(fd.as_raw_fd()) };
    if n < 0 {
        Err(Some(ReferenceProblem::Unreadable))
    } else {
        Ok(unsafe { OwnedFd::from_raw_fd(n) })
    }
}

fn finish_file(
    dir: OwnedFd,
    max: u64,
    budget: Option<&mut ReadBudget>,
    logical: Vec<String>,
    links: Vec<SymlinkHop>,
) -> Step<InsideFile> {
    let name = logical
        .last()
        .cloned()
        .ok_or(Some(ReferenceProblem::NotFound))?;
    let c = c_name(&name)?;
    let st = io(fstatat(&dir, &c))?;
    if is_link(&st) {
        return Err(Some(ReferenceProblem::Changed));
    }
    if !is_reg(&st) {
        return Err(Some(ReferenceProblem::NotRegular));
    }
    let flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK;
    let fd = io(openat(&dir, &c, flags))?;
    finish_opened(fd, st, max, budget, logical, links)
}

fn finish_opened(
    fd: OwnedFd,
    before: libc::stat,
    max: u64,
    budget: Option<&mut ReadBudget>,
    logical: Vec<String>,
    links: Vec<SymlinkHop>,
) -> Step<InsideFile> {
    if before.st_size as u64 > max {
        return Err(Some(ReferenceProblem::TooLarge));
    }
    if budget
        .as_deref()
        .is_some_and(|b| before.st_size as u64 > b.bytes)
    {
        return Err(Some(ReferenceProblem::Budget));
    }
    let mut file = File::from(fd);
    let opened = io(file.metadata())?;
    if !opened.is_file() || opened.dev() != before.st_dev as u64 || opened.ino() != before.st_ino {
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
    if used != opened.len() || after.len() != opened.len() || !same_time {
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
        resolved: logical.join("/"),
        links,
    })
}

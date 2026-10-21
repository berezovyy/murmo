//! Launch rules: wrap only the interactive TUI; every subcommand and anything
//! unrecognized execs stock `codex` with no PTY (lesson 40).

use std::env;
use std::ffi::OsStr;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use crate::RECURSION_GUARD;

/// Subcommands that must never be wrapped: IDE `app-server`, `exec`, `mcp`, …
const SUBCOMMANDS: &[&str] = &[
    "agents",
    "app",
    "app-server",
    "apply",
    "a",
    "archive",
    "completion",
    "debug",
    "delete",
    "doctor",
    "e",
    "exec",
    "execpolicy",
    "fork",
    "login",
    "logout",
    "mcp",
    "migrate-rollouts",
    "plugin",
    "queue",
    "remote-control",
    "resume",
    "review",
    "sandbox",
    "tcp-tunnel",
    "unarchive",
    "update",
];

/// Interactive flags reviewed against `codex --help` for 0.162.x and 0.163.x.
/// A flag not in this list is unrecognized → pass-through.
const FLAGS: &[Flag] = &[
    Flag::switch(&["--no-alt-screen"]),
    Flag::switch(&["--no-daemon"]),
    Flag::switch(&["--search"]),
    Flag::switch(&["--strict-config"]),
    Flag::switch(&["--oss"]),
    Flag::switch(&["--worktree"]),
    Flag::switch(&["--approve-for-me", "--not-so-yolo"]),
    Flag::switch(&["--dangerously-bypass-approvals-and-sandbox", "--yolo"]),
    Flag::switch(&["--dangerously-bypass-hook-trust"]),
    Flag::value(&["-c", "--config"]),
    Flag::value(&["-a", "--ask-for-approval"]),
    Flag::value(&["-i", "--image"]),
    Flag::value(&["-m", "--model"]),
    Flag::value(&["--local-provider"]),
    Flag::value(&["-p", "--profile"]),
    Flag::value(&["-s", "--sandbox"]),
    Flag::value(&["-C", "--cd"]),
    Flag::value(&["--add-dir"]),
];

struct Flag {
    names: &'static [&'static str],
    takes_value: bool,
}

impl Flag {
    const fn switch(names: &'static [&'static str]) -> Self {
        Flag {
            names,
            takes_value: false,
        }
    }
    const fn value(names: &'static [&'static str]) -> Self {
        Flag {
            names,
            takes_value: true,
        }
    }
}

fn flag_of(arg: &str) -> Option<&'static Flag> {
    let name = arg.split_once('=').map(|(n, _)| n).unwrap_or(arg);
    FLAGS.iter().find(|f| f.names.contains(&name))
}

/// What `murmo-codex` should do with its argv (after stripping a leading `codex`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Launch {
    /// Run stock Codex in a PTY and intercept keys.
    Wrap { bin: PathBuf, argv: Vec<String> },
    /// `execvp` stock Codex; no PTY, stdio and exit code preserved.
    PassThrough { bin: PathBuf, argv: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveError {
    Recursion,
    NotFound,
}

impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResolveError::Recursion => write!(
                f,
                "murmo-codex refused to wrap itself (set {RECURSION_GUARD} is the guard; never install a `codex` shim)"
            ),
            ResolveError::NotFound => write!(f, "stock `codex` not found on PATH"),
        }
    }
}

/// Strip a leading `codex` so `murmo-codex codex --version` equals `codex --version`.
pub fn strip_self_name(args: &[String]) -> &[String] {
    match args.first() {
        Some(first) if first == "codex" => &args[1..],
        _ => args,
    }
}

pub fn classify(args: &[String]) -> Kind {
    let args = strip_self_name(args);
    if args
        .iter()
        .any(|a| a == "--help" || a == "-h" || a == "--version" || a == "-V")
    {
        return Kind::PassThrough;
    }
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "--" {
            // Remaining args are the optional TUI prompt, never a subcommand.
            return Kind::Wrap;
        }
        if let Some(rest) = arg.strip_prefix('-') {
            if rest.is_empty() {
                return Kind::PassThrough;
            }
            let Some(flag) = flag_of(arg) else {
                return Kind::PassThrough;
            };
            if flag.takes_value && !arg.contains('=') {
                i += 1;
                if i >= args.len() {
                    return Kind::PassThrough;
                }
            }
            i += 1;
            continue;
        }
        if SUBCOMMANDS.contains(&arg.as_str()) {
            return Kind::PassThrough;
        }
        // Optional TUI prompt (positional). Wrap.
        i += 1;
        while i < args.len() {
            let next = &args[i];
            if next == "--" {
                return Kind::Wrap;
            }
            if next.starts_with('-') {
                let Some(flag) = flag_of(next) else {
                    return Kind::PassThrough;
                };
                if flag.takes_value && !next.contains('=') {
                    i += 1;
                    if i >= args.len() {
                        return Kind::PassThrough;
                    }
                }
                i += 1;
                continue;
            }
            return Kind::PassThrough;
        }
        return Kind::Wrap;
    }
    Kind::Wrap
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Wrap,
    PassThrough,
}

/// True when the user already set `tui.terminal_title` (any `-c`/`--config`).
pub fn user_set_title(args: &[String]) -> bool {
    let args = strip_self_name(args);
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        let value = if let Some(v) = arg.strip_prefix("--config=") {
            Some(v)
        } else if let Some(v) = arg.strip_prefix("-c=") {
            Some(v)
        } else if arg == "--config" || arg == "-c" {
            i += 1;
            args.get(i).map(String::as_str)
        } else {
            None
        };
        if let Some(v) = value {
            if v.contains("tui.terminal_title") {
                return true;
            }
        }
        i += 1;
    }
    false
}

/// Appended only when wrapping and the user did not set a title format (E9).
pub const RUN_STATE_TITLE: &str = r#"tui.terminal_title=["run-state"]"#;

pub fn with_run_state_title(mut argv: Vec<String>) -> Vec<String> {
    if user_set_title(&argv) {
        return argv;
    }
    argv.push("-c".into());
    argv.push(RUN_STATE_TITLE.into());
    argv
}

/// Resolve stock `codex`, skipping this wrapper and honouring `MURMO_CODEX_BIN`.
pub fn resolve_stock(self_exe: &Path, path: &OsStr) -> Result<PathBuf, ResolveError> {
    if env::var_os(RECURSION_GUARD).is_some() {
        return Err(ResolveError::Recursion);
    }
    if let Some(explicit) = env::var_os("MURMO_CODEX_BIN") {
        let p = PathBuf::from(explicit);
        if is_self(&p, self_exe) {
            return Err(ResolveError::Recursion);
        }
        return Ok(p);
    }
    for dir in env::split_paths(path) {
        let candidate = dir.join("codex");
        if !is_executable(&candidate) {
            continue;
        }
        if is_self(&candidate, self_exe) {
            continue;
        }
        if looks_like_wrapper(&candidate) {
            continue;
        }
        return Ok(candidate);
    }
    Err(ResolveError::NotFound)
}

fn is_executable(path: &Path) -> bool {
    path.is_file()
        && fs::metadata(path)
            .map(|m| m.mode() & 0o111 != 0)
            .unwrap_or(false)
}

fn is_self(candidate: &Path, self_exe: &Path) -> bool {
    let ok = |a: &Path, b: &Path| match (fs::metadata(a), fs::metadata(b)) {
        (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
        _ => false,
    };
    if ok(candidate, self_exe) {
        return true;
    }
    let resolved = fs::canonicalize(candidate).ok();
    let self_resolved = fs::canonicalize(self_exe).ok();
    matches!((resolved, self_resolved), (Some(a), Some(b)) if a == b)
}

fn looks_like_wrapper(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n == "murmo-codex" || n.starts_with("murmo"))
}

pub fn launch(self_exe: &Path, args: &[String], path: &OsStr) -> Result<Launch, ResolveError> {
    let bin = resolve_stock(self_exe, path)?;
    let rest = strip_self_name(args).to_vec();
    match classify(args) {
        Kind::Wrap => Ok(Launch::Wrap {
            bin,
            argv: with_run_state_title(rest),
        }),
        Kind::PassThrough => Ok(Launch::PassThrough { bin, argv: rest }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| (*a).to_string()).collect()
    }

    #[test]
    fn subcommands_and_help_pass_through() {
        // Catches wrapping a non-interactive or IDE-spawned Codex (lesson 40).
        for args in [
            s(&["exec", "--help"]),
            s(&["app-server", "--help"]),
            s(&["mcp", "--help"]),
            s(&["update", "--help"]),
            s(&["--version"]),
            s(&["codex", "--version"]),
            s(&["--help"]),
            s(&["login"]),
            s(&["resume", "--last"]),
        ] {
            assert_eq!(classify(&args), Kind::PassThrough, "{args:?}");
        }
    }

    #[test]
    fn interactive_flags_wrap() {
        for args in [
            s(&[]),
            s(&["--no-alt-screen"]),
            s(&["--no-daemon", "--no-alt-screen"]),
            s(&["-c", r#"model_provider="murmo_local""#]),
            s(&["--sandbox", "read-only", "-a", "never"]),
            s(&["hello world"]),
        ] {
            assert_eq!(classify(&args), Kind::Wrap, "{args:?}");
        }
    }

    #[test]
    fn unrecognized_flag_passes_through() {
        assert_eq!(classify(&s(&["--not-a-real-flag"])), Kind::PassThrough);
        assert_eq!(classify(&s(&["mystery"])), Kind::Wrap);
        assert_eq!(classify(&s(&["mystery", "two"])), Kind::PassThrough);
    }

    #[test]
    fn title_flag_is_added_once() {
        let added = with_run_state_title(s(&["--no-alt-screen"]));
        assert!(added
            .windows(2)
            .any(|w| w[0] == "-c" && w[1] == RUN_STATE_TITLE));
        let already = s(&["-c", r#"tui.terminal_title=["cwd"]"#]);
        assert_eq!(with_run_state_title(already.clone()), already);
    }
}

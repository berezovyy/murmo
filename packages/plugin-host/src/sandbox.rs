//! OS sandbox for third-party workers (lesson 48). Built-ins share a guest
//! without it. If the platform cannot apply the sandbox, third-party load fails.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Exit status of a worker whose OS sandbox could not be applied: what
/// `sandbox-exec` returns when the system refuses its profile (EX_OSERR, for
/// one when it is nested in another sandbox) and what `--worker --sandbox`
/// exits with on Linux when landlock or seccomp is refused.
pub const SANDBOX_REFUSED_EXIT: i32 = 71;

/// What a third-party load says when its sandbox could not start. Shown to
/// the user as the reason the plugin did not start; tools match it exactly.
pub const SANDBOX_UNAVAILABLE: &str = "the OS sandbox for third-party plugins could not start";

/// Why a worker closed its output before its first reply: a sandbox the
/// system refused, or a worker that died on its own.
pub fn start_failure(child: &mut Child, sandboxed: bool) -> String {
    let deadline = Instant::now() + Duration::from_millis(1_000);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let refused = status.and_then(|s| s.code()) == Some(SANDBOX_REFUSED_EXIT);
    if sandboxed && refused {
        SANDBOX_UNAVAILABLE.into()
    } else {
        "guest worker exited".into()
    }
}

pub fn spawn_worker(exe: &Path, sandboxed: bool) -> Result<Child, String> {
    if !sandboxed {
        return spawn_plain(exe);
    }
    #[cfg(target_os = "macos")]
    {
        spawn_macos(exe)
    }
    #[cfg(target_os = "linux")]
    {
        spawn_linux(exe)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = exe;
        Err("OS sandbox is not available on this platform; third-party plugins stay off".into())
    }
}

fn spawn_plain(exe: &Path) -> Result<Child, String> {
    Command::new(exe)
        .arg("--worker")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env_clear()
        .current_dir(worker_cwd())
        .spawn()
        .map_err(|e| e.to_string())
}

fn worker_cwd() -> PathBuf {
    let dir = std::env::temp_dir().join("murmo-plugin-host-cwd");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

#[cfg(target_os = "macos")]
fn spawn_macos(exe: &Path) -> Result<Child, String> {
    let profile = macos_profile(exe)?;
    let path = std::env::temp_dir().join(format!("murmo-sandbox-{}.sb", std::process::id()));
    std::fs::write(&path, profile).map_err(|e| e.to_string())?;
    Command::new("/usr/bin/sandbox-exec")
        .arg("-f")
        .arg(&path)
        .arg(exe)
        .arg("--worker")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env_clear()
        .current_dir(worker_cwd())
        .spawn()
        .map_err(|e| format!("sandbox-exec: {e}"))
}

#[cfg(target_os = "macos")]
fn macos_profile(exe: &Path) -> Result<String, String> {
    let exe = exe.to_str().ok_or("exe path")?.replace('"', "\\\"");
    let cwd = worker_cwd();
    let cwd = cwd.to_str().ok_or("cwd")?.replace('"', "\\\"");
    Ok(format!(
        r#"(version 1)
(allow default)
(deny network*)
(deny process-exec)
(deny process-fork)
(allow process-exec (literal "{exe}"))
(deny file-read* (regex #"/\.ssh/"))
(allow file-read* (literal "{exe}") (subpath "{cwd}") (subpath "/usr") (subpath "/System") (subpath "/dev"))
(allow file-write* (subpath "{cwd}") (subpath "/dev"))
(allow sysctl-read)
(allow mach-lookup)
"#
    ))
}

#[cfg(target_os = "linux")]
fn spawn_linux(exe: &Path) -> Result<Child, String> {
    Command::new(exe)
        .arg("--worker")
        .arg("--sandbox")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env_clear()
        .current_dir(worker_cwd())
        .spawn()
        .map_err(|e| e.to_string())
}

/// Apply landlock + seccomp in this process. Called from `--worker --sandbox`.
pub fn apply_linux() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        linux_restrict()
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn linux_restrict() -> Result<(), String> {
    // PR_SET_NO_NEW_PRIVS is required before landlock and seccomp.
    const PR_SET_NO_NEW_PRIVS: i32 = 38;
    // SAFETY: prctl on self.
    let rc = unsafe { libc::prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
    if rc != 0 {
        return Err("prctl NO_NEW_PRIVS failed; third-party plugins stay off".into());
    }
    landlock()?;
    seccomp_block_exec_and_connect()?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn landlock() -> Result<(), String> {
    // landlock_create_ruleset / add_rule / restrict_self. Syscall numbers are
    // 444/445/446 on x86_64 and aarch64.
    const SYS_CREATE: libc::c_long = 444;
    const SYS_ADD: libc::c_long = 445;
    const SYS_RESTRICT: libc::c_long = 446;
    const LANDLOCK_ACCESS_FS_READ_FILE: u64 = 1 << 2;
    const LANDLOCK_ACCESS_FS_READ_DIR: u64 = 1 << 3;
    #[repr(C)]
    struct Attr {
        handled_access_fs: u64,
        handled_access_net: u64,
        scoped: u64,
    }
    let attr = Attr {
        handled_access_fs: LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR,
        handled_access_net: 0,
        scoped: 0,
    };
    // SAFETY: landlock_create_ruleset with a local attr.
    let fd = unsafe {
        libc::syscall(
            SYS_CREATE,
            &attr as *const Attr,
            std::mem::size_of::<Attr>(),
            0,
        )
    };
    if fd < 0 {
        return Err("landlock is not available; third-party plugins stay off".into());
    }
    let cwd = worker_cwd();
    let cstr =
        std::ffi::CString::new(cwd.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
    let path_fd = unsafe {
        libc::open(
            cstr.as_ptr(),
            libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if path_fd < 0 {
        unsafe { libc::close(fd as i32) };
        return Err("landlock cwd open failed".into());
    }
    #[repr(C)]
    struct PathBeneath {
        allowed_access: u64,
        parent_fd: i32,
    }
    let beneath = PathBeneath {
        allowed_access: LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR,
        parent_fd: path_fd,
    };
    const LANDLOCK_RULE_PATH_BENEATH: u32 = 1;
    let add = unsafe {
        libc::syscall(
            SYS_ADD,
            fd,
            LANDLOCK_RULE_PATH_BENEATH,
            &beneath as *const PathBeneath,
            0,
        )
    };
    unsafe { libc::close(path_fd) };
    if add != 0 {
        unsafe { libc::close(fd as i32) };
        return Err("landlock add_rule failed".into());
    }
    let restrict = unsafe { libc::syscall(SYS_RESTRICT, fd, 0) };
    unsafe { libc::close(fd as i32) };
    if restrict != 0 {
        return Err("landlock restrict_self failed".into());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn seccomp_block_exec_and_connect() -> Result<(), String> {
    // SECCOMP_MODE_FILTER with a tiny BPF: deny execve, execveat, connect.
    // Allow everything else so QuickJS keeps working.
    const PR_SET_SECCOMP: i32 = 22;
    const SECCOMP_MODE_FILTER: usize = 2;
    const AUDIT_ARCH_X86_64: u32 = 0xC000_003E;
    const AUDIT_ARCH_AARCH64: u32 = 0xC000_00B7;
    #[cfg(target_arch = "x86_64")]
    const AUDIT_ARCH: u32 = AUDIT_ARCH_X86_64;
    #[cfg(target_arch = "aarch64")]
    const AUDIT_ARCH: u32 = AUDIT_ARCH_AARCH64;
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    const AUDIT_ARCH: u32 = 0;
    if AUDIT_ARCH == 0 {
        return Err("seccomp: unsupported architecture".into());
    }
    #[cfg(target_arch = "x86_64")]
    const NR_EXECVE: i32 = 59;
    #[cfg(target_arch = "x86_64")]
    const NR_EXECVEAT: i32 = 322;
    #[cfg(target_arch = "x86_64")]
    const NR_CONNECT: i32 = 42;
    #[cfg(target_arch = "aarch64")]
    const NR_EXECVE: i32 = 221;
    #[cfg(target_arch = "aarch64")]
    const NR_EXECVEAT: i32 = 281;
    #[cfg(target_arch = "aarch64")]
    const NR_CONNECT: i32 = 203;
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    const NR_EXECVE: i32 = 0;
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    const NR_EXECVEAT: i32 = 0;
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    const NR_CONNECT: i32 = 0;

    // sock_filter: {code, jt, jf, k}
    #[repr(C)]
    struct SockFilter {
        code: u16,
        jt: u8,
        jf: u8,
        k: u32,
    }
    #[repr(C)]
    struct SockFprog {
        len: u16,
        filter: *const SockFilter,
    }
    const BPF_LD: u16 = 0x00;
    const BPF_W: u16 = 0x00;
    const BPF_ABS: u16 = 0x20;
    const BPF_JMP: u16 = 0x05;
    const BPF_JEQ: u16 = 0x10;
    const BPF_K: u16 = 0x00;
    const BPF_RET: u16 = 0x06;
    const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
    const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
    // seccomp_data.nr at 0, arch at 4.
    let filter = [
        SockFilter {
            code: BPF_LD | BPF_W | BPF_ABS,
            jt: 0,
            jf: 0,
            k: 4,
        },
        SockFilter {
            code: BPF_JMP | BPF_JEQ | BPF_K,
            jt: 1,
            jf: 0,
            k: AUDIT_ARCH,
        },
        SockFilter {
            code: BPF_RET | BPF_K,
            jt: 0,
            jf: 0,
            k: SECCOMP_RET_KILL_PROCESS,
        },
        SockFilter {
            code: BPF_LD | BPF_W | BPF_ABS,
            jt: 0,
            jf: 0,
            k: 0,
        },
        SockFilter {
            code: BPF_JMP | BPF_JEQ | BPF_K,
            jt: 3,
            jf: 0,
            k: NR_EXECVE as u32,
        },
        SockFilter {
            code: BPF_JMP | BPF_JEQ | BPF_K,
            jt: 2,
            jf: 0,
            k: NR_EXECVEAT as u32,
        },
        SockFilter {
            code: BPF_JMP | BPF_JEQ | BPF_K,
            jt: 1,
            jf: 0,
            k: NR_CONNECT as u32,
        },
        SockFilter {
            code: BPF_RET | BPF_K,
            jt: 0,
            jf: 0,
            k: SECCOMP_RET_ALLOW,
        },
        SockFilter {
            code: BPF_RET | BPF_K,
            jt: 0,
            jf: 0,
            k: SECCOMP_RET_KILL_PROCESS,
        },
    ];
    let prog = SockFprog {
        len: filter.len() as u16,
        filter: filter.as_ptr(),
    };
    let rc = unsafe {
        libc::prctl(
            PR_SET_SECCOMP,
            SECCOMP_MODE_FILTER,
            &prog as *const SockFprog,
        )
    };
    if rc != 0 {
        return Err("seccomp filter failed; third-party plugins stay off".into());
    }
    Ok(())
}

/// True when this platform's worker sandbox denies network (seatbelt or seccomp).
pub fn policy_denies_network() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos_profile(Path::new("/usr/bin/true"))
            .map(|p| p.contains("(deny network*)"))
            .unwrap_or(false)
    }
    #[cfg(target_os = "linux")]
    {
        // seccomp_block_exec_and_connect denies connect(2).
        true
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        false
    }
}

/// Four r11 probes from a sandboxed process (E27).
pub fn run_probes(canary: &str, port: u16) -> String {
    let mut file_ok = false;
    let mut file_err = String::new();
    match std::fs::read_to_string(canary) {
        Ok(s) => file_ok = s == "CANARY_ONLY",
        Err(e) => file_err = e.to_string(),
    }
    let spawn = std::process::Command::new("/usr/bin/true").status();
    let spawn_ok = spawn.map(|s| s.success()).unwrap_or(false);
    let env_ok = std::env::var("FAKE_SECRET").ok().as_deref() == Some("SYNTHETIC_SECRET");
    let tcp_ok = std::net::TcpStream::connect(("127.0.0.1", port)).is_ok();
    serde_json::json!({
        "file": file_ok,
        "fileError": file_err,
        "spawn": spawn_ok,
        "env": env_ok,
        "tcp": tcp_ok,
    })
    .to_string()
}

pub fn write_probe_home(dir: &Path) -> Result<PathBuf, String> {
    let ssh = dir.join(".ssh");
    std::fs::create_dir_all(&ssh).map_err(|e| e.to_string())?;
    let canary = ssh.join("id_fake");
    let mut f = std::fs::File::create(&canary).map_err(|e| e.to_string())?;
    f.write_all(b"CANARY_ONLY").map_err(|e| e.to_string())?;
    Ok(canary)
}

/// Run the four r11 probes inside the same sandbox workers get (E27).
pub fn run_sandboxed_probes(
    exe: &Path,
    canary: &str,
    port: u16,
) -> Result<serde_json::Value, String> {
    let output = sandboxed_probe_command(exe, canary, port)?
        .output()
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let line = stdout
        .lines()
        .rev()
        .find(|l| l.starts_with('{'))
        .unwrap_or("");
    serde_json::from_str(line).map_err(|e| format!("{e}: stdout={stdout} stderr={stderr}"))
}

fn sandboxed_probe_command(exe: &Path, canary: &str, port: u16) -> Result<Command, String> {
    #[cfg(target_os = "macos")]
    {
        let profile = macos_profile(exe)?;
        let path = std::env::temp_dir().join(format!("murmo-probe-{}.sb", std::process::id()));
        std::fs::write(&path, profile).map_err(|e| e.to_string())?;
        let mut cmd = Command::new("/usr/bin/sandbox-exec");
        cmd.arg("-f")
            .arg(&path)
            .arg(exe)
            .arg("--sandbox-probe")
            .arg("--canary")
            .arg(canary)
            .arg("--port")
            .arg(port.to_string())
            .env_clear()
            .current_dir(worker_cwd())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        Ok(cmd)
    }
    #[cfg(target_os = "linux")]
    {
        let mut cmd = Command::new(exe);
        cmd.arg("--sandbox-probe")
            .arg("--apply")
            .arg("--canary")
            .arg(canary)
            .arg("--port")
            .arg(port.to_string())
            .env_clear()
            .current_dir(worker_cwd())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        Ok(cmd)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (exe, canary, port);
        Err("OS sandbox is not available on this platform; third-party plugins stay off".into())
    }
}

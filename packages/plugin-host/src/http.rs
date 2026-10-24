//! HTTP over a Unix socket folded into the supervisor: Claude's
//! `$.http.fetch({socketPath})` talks to this process directly, saving the
//! extra proxy process r11b measured (E4). No TCP: any local user can reach a
//! loopback port, while the socket file is the user's own (mode 0600).

use std::ffi::CString;
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};

use crate::protocol::ready_message;
use crate::supervisor::Supervisor;

static RPC_COUNT: AtomicU64 = AtomicU64::new(0);
static NON_RPC_POSTS: AtomicU64 = AtomicU64::new(0);
static STOP: Mutex<bool> = Mutex::new(false);
static WAKE: Condvar = Condvar::new();
static SOCKET: OnceLock<CString> = OnceLock::new();

/// Claude 2.1.306 sends SIGTERM to what `$.process.spawn` started when it
/// exits, before `session.end` can ask for `shutdown`; without this the
/// socket file outlives the helper. Workers see their stdin close and exit.
extern "C" fn on_terminate(signal: libc::c_int) {
    if let Some(path) = SOCKET.get() {
        // SAFETY: unlink(2) is async-signal-safe; `path` is set before the handler is installed.
        unsafe { libc::unlink(path.as_ptr()) };
    }
    // SAFETY: _exit(2) is async-signal-safe.
    unsafe { libc::_exit(128 + signal) }
}

fn remove_socket_on_termination(socket: &str) {
    let Ok(path) = CString::new(socket) else {
        return;
    };
    if SOCKET.set(path).is_err() {
        return;
    }
    for signal in [libc::SIGTERM, libc::SIGHUP, libc::SIGINT] {
        // SAFETY: installs a handler that only calls async-signal-safe functions.
        unsafe { libc::signal(signal, on_terminate as *const () as libc::sighandler_t) };
    }
}

/// A socket this young may belong to a helper between its bind and listen.
const STALE_AFTER: Duration = Duration::from_secs(2);

/// `murmo-` plus eight hex digits plus `.sock`: the names the Claude adapter
/// gives its helpers (`packages/adapters/claude/src/helper.ts`).
fn is_helper_socket_name(name: &str) -> bool {
    name.strip_prefix("murmo-")
        .and_then(|rest| rest.strip_suffix(".sock"))
        .is_some_and(|id| id.len() == 8 && id.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Removes helper sockets in `socket`'s folder that nobody listens on any
/// more. A SIGKILLed helper cannot unlink its own, so each crash left one more
/// file, in the shared /tmp when `$TMPDIR` is too deep for `sun_path`. Only the
/// user's own socket files with a helper's name go, and only when a connect is
/// refused and they are older than a helper's start-up.
fn remove_stale_sockets(socket: &Path) {
    let Some(dir) = socket.parent() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    // SAFETY: geteuid(2) has no failure mode.
    let uid = unsafe { libc::geteuid() };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        if path == socket
            || !entry
                .file_name()
                .to_str()
                .is_some_and(is_helper_socket_name)
        {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        let old = meta
            .modified()
            .ok()
            .and_then(|at| now.duration_since(at).ok())
            .is_some_and(|age| age >= STALE_AFTER);
        if !meta.file_type().is_socket() || meta.uid() != uid || !old {
            continue;
        }
        if matches!(UnixStream::connect(&path), Err(e) if e.kind() == ErrorKind::ConnectionRefused)
        {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// How often the helper checks that it still has its parent.
const PARENT_POLL: Duration = Duration::from_millis(200);

fn read_http<S: Read>(stream: &mut S) -> Option<(String, Vec<u8>)> {
    let mut bytes = Vec::new();
    let mut block = [0u8; 4096];
    let header_end;
    loop {
        let n = stream.read(&mut block).ok()?;
        if n == 0 {
            return None;
        }
        bytes.extend_from_slice(&block[..n]);
        if bytes.len() > 1024 * 1024 {
            return None;
        }
        if let Some(p) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            header_end = p + 4;
            break;
        }
    }
    let head = String::from_utf8_lossy(&bytes[..header_end]).into_owned();
    let length = head.lines().find_map(|l| {
        l.split_once(':').and_then(|(k, v)| {
            k.eq_ignore_ascii_case("content-length")
                .then(|| v.trim().parse::<usize>().ok())
                .flatten()
        })
    })?;
    if length > 1024 * 1024 {
        return None;
    }
    while bytes.len() < header_end + length {
        let n = stream.read(&mut block).ok()?;
        if n == 0 {
            return None;
        }
        bytes.extend_from_slice(&block[..n]);
    }
    Some((head, bytes[header_end..header_end + length].to_vec()))
}

fn write_http<S: Write>(stream: &mut S, body: &str) {
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

fn handle_connection<S: Read + Write>(
    mut stream: S,
    supervisor: Arc<Supervisor>,
    serial: Arc<AtomicU64>,
) {
    loop {
        let Some((head, body)) = read_http(&mut stream) else {
            return;
        };
        let mut stop = false;
        let reply = if head.starts_with("POST /rpc ") {
            RPC_COUNT.fetch_add(1, Ordering::Relaxed);
            match serde_json::from_slice::<Value>(&body) {
                Ok(q) if q.get("op").and_then(Value::as_str) == Some("shutdown") => {
                    stop = true;
                    json!({"status": "ok"}).to_string()
                }
                Ok(mut q) => {
                    if q.get("id").is_none() {
                        q["id"] = json!(serial.fetch_add(1, Ordering::Relaxed));
                    }
                    let id = q.get("id").and_then(Value::as_u64);
                    let wait = id.map(|i| supervisor.wait_for(i));
                    match supervisor.dispatch(q) {
                        Some(response) => {
                            if let Some(id) = id {
                                let _ = supervisor.take_pending(id);
                            }
                            response.to_string()
                        }
                        None => match wait {
                            Some(rx) => rx
                                .recv_timeout(Duration::from_secs(8))
                                .map(|v| v.to_string())
                                .unwrap_or_else(|_| {
                                    json!({"status":"error","kind":"transport","error":"HTTP bridge timeout"})
                                        .to_string()
                                }),
                            None => json!({"status":"error","kind":"transport","error":"no reply"}).to_string(),
                        },
                    }
                }
                Err(_) => json!({"error": "invalid JSON"}).to_string(),
            }
        } else {
            if head.starts_with("POST ") || head.starts_with("GET ") {
                NON_RPC_POSTS.fetch_add(1, Ordering::Relaxed);
            }
            json!({
                "ok": true,
                "data": [],
                "rpcRequests": RPC_COUNT.load(Ordering::Relaxed),
                "nonRpcPosts": NON_RPC_POSTS.load(Ordering::Relaxed),
            })
            .to_string()
        };
        write_http(&mut stream, &reply);
        if stop {
            // After the reply is out: the main thread then exits the process.
            *STOP.lock().expect("stop") = true;
            WAKE.notify_all();
            return;
        }
    }
}

/// Serve HTTP on `--socket PATH` until `shutdown` arrives or the parent exits.
/// Claude's `$.process.spawn` gives the child no stdin, so stdin EOF says
/// nothing about the session (it ended the helper right after ready on Claude
/// 2.1.306); a re-parented helper means the plugin runtime is gone, crashed or
/// not.
pub fn serve(socket: String) {
    let parent = std::os::unix::process::parent_id();
    let supervisor = Arc::new(Supervisor::new());
    let serial = Arc::new(AtomicU64::new(1));
    let _ = std::fs::remove_file(&socket);
    let unix = match UnixListener::bind(&socket) {
        Ok(unix) => unix,
        Err(e) => {
            // A path over sun_path's 104 bytes fails here (E11).
            eprintln!("murmo-plugin-host: cannot listen on {socket}: {e}");
            std::process::exit(2);
        }
    };
    let _ = std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600));
    remove_socket_on_termination(&socket);

    let ready = {
        let mut v = ready_message(std::process::id());
        v["socket"] = json!(socket);
        v
    };
    println!("{ready}");
    let _ = std::io::Write::flush(&mut std::io::stdout());
    // After ready, so a full /tmp never delays the session's first request.
    let own = std::path::PathBuf::from(&socket);
    std::thread::spawn(move || remove_stale_sockets(&own));

    let u_sup = supervisor.clone();
    let u_serial = serial.clone();
    std::thread::spawn(move || {
        for stream in unix.incoming().flatten() {
            let s = u_sup.clone();
            let n = u_serial.clone();
            std::thread::spawn(move || handle_connection(stream, s, n));
        }
    });

    let mut stop = STOP.lock().expect("stop");
    while !*stop && std::os::unix::process::parent_id() == parent {
        stop = WAKE.wait_timeout(stop, PARENT_POLL).expect("stop").0;
    }
    drop(stop);
    supervisor.stop_all();
    let _ = std::fs::remove_file(socket);
}

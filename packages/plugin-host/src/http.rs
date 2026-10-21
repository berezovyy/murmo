//! HTTP-over-Unix-socket (and optional loopback TCP) folded into the
//! supervisor: Claude's `$.http.fetch({socketPath})` talks to this process
//! directly, saving the extra proxy process r11b measured (E4).

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::protocol::ready_message;
use crate::supervisor::Supervisor;

static RPC_COUNT: AtomicU64 = AtomicU64::new(0);
static NON_RPC_POSTS: AtomicU64 = AtomicU64::new(0);

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
        let reply = if head.starts_with("POST /rpc ") {
            RPC_COUNT.fetch_add(1, Ordering::Relaxed);
            match serde_json::from_slice::<Value>(&body) {
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
    }
}

/// Serve HTTP on `--socket PATH` and a loopback TCP port, plus stdin.
pub fn serve(socket: String) {
    let supervisor = Arc::new(Supervisor::new());
    let serial = Arc::new(AtomicU64::new(1));
    let tcp = TcpListener::bind(("127.0.0.1", 0)).expect("loopback");
    let port = tcp.local_addr().expect("addr").port();
    let _ = std::fs::remove_file(&socket);
    let unix = UnixListener::bind(&socket).expect("unix socket");

    let ready = {
        let mut v = ready_message(std::process::id());
        v["port"] = json!(port);
        v["socket"] = json!(socket);
        v
    };
    println!("{ready}");
    let _ = std::io::Write::flush(&mut std::io::stdout());

    let u_sup = supervisor.clone();
    let u_serial = serial.clone();
    std::thread::spawn(move || {
        for stream in unix.incoming().flatten() {
            let s = u_sup.clone();
            let n = u_serial.clone();
            std::thread::spawn(move || handle_connection::<UnixStream>(stream, s, n));
        }
    });

    let t_sup = supervisor.clone();
    let t_serial = serial.clone();
    std::thread::spawn(move || {
        for stream in tcp.incoming().flatten() {
            let s = t_sup.clone();
            let n = t_serial.clone();
            std::thread::spawn(move || handle_connection::<TcpStream>(stream, s, n));
        }
    });

    crate::supervisor::serve_stdio(&supervisor);
    let _ = std::fs::remove_file(socket);
}

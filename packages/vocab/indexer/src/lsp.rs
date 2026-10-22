//! Opt-in stdio JSON-RPC LSP client. Starts a configured server from PATH,
//! collects workspace/document symbols, then kills the process group.

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::record::NameRecord;
use crate::source::SOURCE_LSP;
use crate::split::word_key;

pub const LSP_TIMEOUT_MS: u64 = 60_000;
const MAX_OPEN_FILES: usize = 80;

#[derive(Clone, Debug, Default)]
pub struct LspResult {
    pub records: Vec<NameRecord>,
    pub error: Option<String>,
    pub server: String,
}

pub fn run_servers(
    root: &Path,
    servers: &[String],
    timeout_ms: u64,
    tagged_files: &HashSet<String>,
) -> Vec<LspResult> {
    servers
        .iter()
        .map(|s| run_one(root, s, timeout_ms, tagged_files))
        .collect()
}

fn run_one(
    root: &Path,
    server: &str,
    timeout_ms: u64,
    tagged_files: &HashSet<String>,
) -> LspResult {
    if !server_name_ok(server) {
        return LspResult {
            server: server.to_string(),
            error: Some("lsp server name refused".into()),
            records: Vec::new(),
        };
    }
    let Some(bin) = find_on_path(server) else {
        return LspResult {
            server: server.to_string(),
            error: Some(format!("server {server} not on PATH")),
            records: Vec::new(),
        };
    };
    match collect(root, &bin, server, timeout_ms, tagged_files) {
        Ok(records) => LspResult {
            server: server.to_string(),
            records,
            error: None,
        },
        Err(e) => LspResult {
            server: server.to_string(),
            error: Some(e),
            records: Vec::new(),
        },
    }
}

pub fn server_name_ok(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    name.len() <= 64
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
        && !name.contains('/')
        && !name.contains('\\')
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn collect(
    root: &Path,
    bin: &Path,
    server: &str,
    timeout_ms: u64,
    tagged_files: &HashSet<String>,
) -> Result<Vec<NameRecord>, String> {
    let canon = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let root_uri = path_uri(&canon);
    let mut cmd = Command::new(bin);
    cmd.arg("--stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .current_dir(&canon)
        .env_clear();
    for key in ["PATH", "HOME", "LANG", "LC_ALL", "USER", "TMPDIR", "TMP"] {
        if let Ok(v) = std::env::var(key) {
            cmd.env(key, v);
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| format!("spawn {server}: {e}"))?;
    let flag = Arc::new(AtomicBool::new(false));
    let watchdog = {
        let flag = Arc::clone(&flag);
        let pid = child.id();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(timeout_ms.max(50)));
            if !flag.load(Ordering::SeqCst) {
                kill_group(pid);
            }
        })
    };
    let result = session(&mut child, &canon, &root_uri, tagged_files, timeout_ms);
    flag.store(true, Ordering::SeqCst);
    kill_group(child.id());
    let _ = child.wait();
    let _ = watchdog.join();
    result
}

fn session(
    child: &mut Child,
    root: &Path,
    root_uri: &str,
    tagged_files: &HashSet<String>,
    timeout_ms: u64,
) -> Result<Vec<NameRecord>, String> {
    let mut stdin = child.stdin.take().ok_or("lsp stdin")?;
    let stdout = child.stdout.take().ok_or("lsp stdout")?;
    let mut reader = BufReader::new(stdout);
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut next_id = 1i64;
    let init = rpc(
        &mut stdin,
        &mut reader,
        &mut next_id,
        "initialize",
        json!({
            "processId": std::process::id(),
            "rootUri": root_uri,
            "workspaceFolders": [{"uri": root_uri, "name": "repo"}],
            "capabilities": { "workspace": { "symbol": { "dynamicRegistration": false } } },
            "initializationOptions": {
                "disableAutomaticTypingAcquisition": true,
                "preferences": { "includePackageJsonAutoImports": "off" }
            }
        }),
        deadline,
    )?;
    if init.get("error").is_some() {
        return Err(init
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("initialize failed")
            .to_string());
    }
    notify(&mut stdin, "initialized", json!({}))?;
    let mut records = Vec::new();
    let mut seen = HashSet::new();
    let mut queries: Vec<String> = vec![String::new()];
    for c in b'a'..=b'z' {
        queries.push((c as char).to_string());
    }
    let mut query_error: Option<String> = None;
    for q in queries {
        let resp = rpc(
            &mut stdin,
            &mut reader,
            &mut next_id,
            "workspace/symbol",
            json!({ "query": q }),
            deadline,
        );
        let msg = match resp {
            Ok(msg) => msg,
            Err(e) => {
                query_error = Some(e);
                break;
            }
        };
        let Some(arr) = msg.get("result").and_then(Value::as_array) else {
            continue;
        };
        for sym in arr {
            if let Some(rec) = symbol_record(sym, root, root_uri) {
                let k = (rec.name.clone(), rec.file.clone(), rec.line);
                if seen.insert(k) {
                    records.push(rec);
                }
            }
        }
    }
    let uncovered: Vec<String> = tagged_files
        .iter()
        .filter(|p| {
            let ext = p.rsplit('.').next().unwrap_or("");
            matches!(ext, "ts" | "tsx" | "js" | "jsx" | "py" | "rs" | "go")
        })
        .take(MAX_OPEN_FILES)
        .cloned()
        .collect();
    for rel in uncovered.iter().take(MAX_OPEN_FILES) {
        let uri = format!("{root_uri}/{}", rel.trim_start_matches('/'));
        let resp = rpc(
            &mut stdin,
            &mut reader,
            &mut next_id,
            "textDocument/documentSymbol",
            json!({ "textDocument": { "uri": uri } }),
            deadline,
        );
        let Ok(msg) = resp else {
            continue;
        };
        collect_doc_symbols(
            msg.get("result").unwrap_or(&Value::Null),
            rel,
            root,
            root_uri,
            &mut records,
            &mut seen,
        );
    }
    if records.is_empty() {
        if let Some(e) = query_error {
            return Err(e);
        }
    }
    let _ = rpc(
        &mut stdin,
        &mut reader,
        &mut next_id,
        "shutdown",
        json!(null),
        deadline,
    );
    let _ = notify(&mut stdin, "exit", json!(null));
    Ok(records)
}

fn collect_doc_symbols(
    value: &Value,
    rel: &str,
    root: &Path,
    root_uri: &str,
    records: &mut Vec<NameRecord>,
    seen: &mut HashSet<(String, String, u32)>,
) {
    let Some(arr) = value.as_array() else {
        return;
    };
    for item in arr {
        if let Some(rec) = doc_symbol_record(item, rel, root, root_uri) {
            let k = (rec.name.clone(), rec.file.clone(), rec.line);
            if seen.insert(k) {
                records.push(rec);
            }
        }
        if let Some(children) = item.get("children") {
            collect_doc_symbols(children, rel, root, root_uri, records, seen);
        }
    }
}

fn definition_kind(kind: u64) -> Option<&'static str> {
    match kind {
        5 | 23 => Some("class"),
        6 | 9 => Some("method"),
        10 | 11 | 26 => Some("type"),
        12 => Some("function"),
        14 | 22 => Some("constant"),
        _ => None,
    }
}

fn symbol_record(sym: &Value, root: &Path, root_uri: &str) -> Option<NameRecord> {
    let name = sym.get("name")?.as_str()?;
    if name.is_empty() {
        return None;
    }
    let kind = definition_kind(sym.get("kind")?.as_u64()?)?;
    let loc = sym.get("location")?;
    let uri = loc.get("uri")?.as_str()?;
    let file = uri_to_rel(uri, root, root_uri)?;
    let line = loc
        .get("range")
        .and_then(|r| r.get("start"))
        .and_then(|s| s.get("line"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32
        + 1;
    let owner = sym
        .get("containerName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Some(NameRecord {
        name: name.to_string(),
        kind: kind.into(),
        file,
        line,
        refs: 1,
        owner,
        source: SOURCE_LSP,
        key: word_key(name),
    })
}

fn doc_symbol_record(sym: &Value, rel: &str, root: &Path, root_uri: &str) -> Option<NameRecord> {
    let name = sym.get("name")?.as_str()?;
    if name.is_empty() {
        return None;
    }
    let kind = definition_kind(sym.get("kind")?.as_u64()?)?;
    let range = sym.get("selectionRange").or_else(|| sym.get("range"))?;
    let line = range
        .get("start")
        .and_then(|s| s.get("line"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32
        + 1;
    let file = if rel.is_empty() {
        let uri = sym.get("location")?.get("uri")?.as_str()?;
        uri_to_rel(uri, root, root_uri)?
    } else {
        rel.to_string()
    };
    Some(NameRecord {
        name: name.to_string(),
        kind: kind.into(),
        file,
        line,
        refs: 1,
        owner: String::new(),
        source: SOURCE_LSP,
        key: word_key(name),
    })
}

fn uri_to_rel(uri: &str, root: &Path, root_uri: &str) -> Option<String> {
    let path = percent_decode(uri.strip_prefix("file://")?);
    let p = PathBuf::from(&path);
    let canon = p.canonicalize().ok()?;
    if !canon.starts_with(root) {
        return None;
    }
    let rel = canon
        .strip_prefix(root)
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");
    if rel.is_empty() {
        None
    } else {
        let _ = root_uri;
        Some(rel)
    }
}

fn percent_decode(s: &str) -> String {
    let mut out = Vec::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) =
                u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16)
            {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn path_uri(path: &Path) -> String {
    let s = path.to_string_lossy();
    if s.starts_with('/') {
        format!("file://{s}")
    } else {
        format!("file:///{s}")
    }
}

fn notify(stdin: &mut impl Write, method: &str, params: Value) -> Result<(), String> {
    write_msg(
        stdin,
        json!({ "jsonrpc": "2.0", "method": method, "params": params }),
    )
}

fn rpc(
    stdin: &mut impl Write,
    reader: &mut BufReader<impl Read>,
    next_id: &mut i64,
    method: &str,
    params: Value,
    deadline: Instant,
) -> Result<Value, String> {
    let id = *next_id;
    *next_id += 1;
    write_msg(
        stdin,
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
    )?;
    loop {
        if Instant::now() >= deadline {
            return Err("lsp timeout".into());
        }
        let msg = read_msg(reader)?;
        if msg.get("id") == Some(&json!(id)) {
            return Ok(msg);
        }
        if msg.get("method").is_some() && msg.get("id").is_some() {
            let rid = msg.get("id").cloned().unwrap_or(Value::Null);
            let _ = write_msg(
                stdin,
                json!({ "jsonrpc": "2.0", "id": rid, "result": null }),
            );
        }
    }
}

fn write_msg(stdin: &mut impl Write, msg: Value) -> Result<(), String> {
    let body = serde_json::to_vec(&msg).map_err(|e| e.to_string())?;
    write!(stdin, "Content-Length: {}\r\n\r\n", body.len()).map_err(|e| e.to_string())?;
    stdin.write_all(&body).map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}

fn read_msg(reader: &mut BufReader<impl Read>) -> Result<Value, String> {
    let mut content_len = None;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("lsp eof".into());
        }
        let t = line.trim_end();
        if t.is_empty() {
            break;
        }
        if let Some(v) = t.strip_prefix("Content-Length:") {
            content_len = v.trim().parse().ok();
        }
    }
    let len = content_len.ok_or("lsp missing Content-Length")?;
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).map_err(|e| e.to_string())?;
    serde_json::from_slice(&buf).map_err(|e| e.to_string())
}

fn kill_group(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::killpg(pid as i32, libc::SIGTERM);
        thread::sleep(Duration::from_millis(50));
        libc::killpg(pid as i32, libc::SIGKILL);
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
    }
}

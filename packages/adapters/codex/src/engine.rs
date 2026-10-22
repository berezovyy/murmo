//! rquickjs bridge: one JS policy, exceptions caught at the boundary so the
//! forwarding loop never panics (Proposal: panic-free key path).

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::{Duration, Instant};

use murmo_js_runtime::{create_runtime, Limits};
use rquickjs::{ArrayBuffer, CaughtError, Context, Function};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::helper::Helper;
use crate::session::Inner;
use crate::{ENGINE_MEMORY_BYTES, ENGINE_STACK_BYTES, KEY_BUDGET_MS};

const BUNDLE: &str = include_str!(concat!(env!("OUT_DIR"), "/engine.js"));

pub struct Engine {
    context: Context,
    runtime: rquickjs::Runtime,
    deadline: Rc<Cell<Option<Instant>>>,
}

impl Engine {
    pub fn start(
        inner: Rc<RefCell<Inner>>,
        helper: Option<Rc<RefCell<Helper>>>,
        table: Option<&[u8]>,
        table_meta: &Value,
        config: &Value,
    ) -> Result<Self, String> {
        let limits = Limits {
            memory_bytes: ENGINE_MEMORY_BYTES,
            stack_bytes: ENGINE_STACK_BYTES,
        };
        let runtime = create_runtime(limits).map_err(|e| e.to_string())?;
        let deadline: Rc<Cell<Option<Instant>>> = Rc::new(Cell::new(None));
        let watch = deadline.clone();
        runtime.set_interrupt_handler(Some(Box::new(move || {
            watch.get().is_some_and(|d| Instant::now() >= d)
        })));
        let context = Context::full(&runtime).map_err(|e| e.to_string())?;

        let host = inner.clone();
        let clock = deadline.clone();
        let rpc_id = Rc::new(Cell::new(0u64));
        let rpc_n = rpc_id.clone();
        let helper_writer = helper.as_ref().map(|h| h.borrow().writer());

        context.with(|c| {
            c.globals()
                .set(
                    "__host",
                    Function::new(c.clone(), move |line: String| -> String {
                        clock.set(None);
                        let v: Value = serde_json::from_str(&line).unwrap_or(json!({}));
                        let out = host.borrow_mut().host(&v);
                        clock.set(Some(Instant::now() + Duration::from_millis(KEY_BUDGET_MS)));
                        out.to_string()
                    }),
                )
                .map_err(|e: rquickjs::Error| e.to_string())?;
            c.globals()
                .set(
                    "__sha256",
                    Function::new(c.clone(), |bytes: Vec<u8>| -> String { sha256_hex(&bytes) }),
                )
                .map_err(|e: rquickjs::Error| e.to_string())?;
            if let Some(writer) = helper_writer {
                c.globals()
                    .set(
                        "__rpc",
                        Function::new(c.clone(), move |line: String| -> u64 {
                            let id = rpc_n.get() + 1;
                            rpc_n.set(id);
                            let mut q: Value = serde_json::from_str(&line).unwrap_or(json!({}));
                            q["id"] = json!(id);
                            if let Ok(mut input) = writer.lock() {
                                use std::io::Write;
                                let _ = writeln!(input, "{q}");
                                let _ = input.flush();
                            }
                            id
                        }),
                    )
                    .map_err(|e: rquickjs::Error| e.to_string())?;
            }
            c.globals()
                .set("__configJSON", config.to_string())
                .map_err(|e: rquickjs::Error| e.to_string())?;
            c.globals()
                .set("__tableMetaJSON", table_meta.to_string())
                .map_err(|e: rquickjs::Error| e.to_string())?;
            if let Some(bytes) = table {
                c.globals()
                    .set(
                        "__inlineAsset",
                        ArrayBuffer::new(c.clone(), bytes.to_vec()).map_err(|e| e.to_string())?,
                    )
                    .map_err(|e: rquickjs::Error| e.to_string())?;
            }
            let source = std::env::var("MURMO_BUNDLE")
                .ok()
                .and_then(|p| std::fs::read_to_string(p).ok())
                .unwrap_or_else(|| BUNDLE.to_string());
            let result = c.eval::<(), _>(source);
            CaughtError::catch(&c, result).map_err(|e| format!("{e:?}"))?;
            Ok::<(), String>(())
        })?;

        Ok(Engine {
            context,
            runtime,
            deadline,
        })
    }

    pub fn call(&self, name: &str, arg: &str) -> Result<String, String> {
        self.deadline
            .set(Some(Instant::now() + Duration::from_millis(KEY_BUDGET_MS)));
        let result = self.context.with(|c| {
            let result = (|| {
                let f: Function = c.globals().get(name)?;
                f.call::<_, String>((arg,))
            })();
            CaughtError::catch(&c, result).map_err(|e| format!("{e:?}"))
        });
        self.deadline.set(None);
        result
    }

    pub fn jobs(&self) {
        for _ in 0..1000 {
            if !self.runtime.is_job_pending() {
                break;
            }
            if self.runtime.execute_pending_job().is_err() {
                crate::trace::emit(&json!({"event": "js-job-error"}));
                break;
            }
        }
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

#[cfg(test)]
mod tests {
    use super::english_table_path;
    use std::fs;
    use std::sync::Mutex;

    static ENV: Mutex<()> = Mutex::new(());

    #[test]
    fn packed_package_root_finds_english_bin() {
        let _g = ENV.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("murmo-table-{}", std::process::id()));
        fs::create_dir_all(dir.join("data/en")).unwrap();
        fs::write(dir.join("data/en/english.bin"), [0u8; 32]).unwrap();
        std::env::remove_var("MURMO_ENGLISH_TABLE");
        std::env::set_var("MURMO_PACKAGE_ROOT", &dir);
        let path = english_table_path().expect("table under MURMO_PACKAGE_ROOT");
        assert!(path.ends_with("english.bin"));
        std::env::remove_var("MURMO_PACKAGE_ROOT");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn table_entries_reads_packed_count() {
        let mut bytes = vec![0u8; 32];
        bytes[4..8].copy_from_slice(&88_525u32.to_le_bytes());
        assert_eq!(super::table_entries(&bytes), Some(88_525));
        assert_eq!(super::table_entries(&[1, 2, 3]), None);
    }
}

pub fn table_entries(bytes: &[u8]) -> Option<u32> {
    if bytes.len() < 8 {
        return None;
    }
    Some(u32::from_le_bytes(bytes[4..8].try_into().ok()?))
}

fn table_exists(path: &std::path::Path) -> bool {
    path.is_file()
}

/// `MURMO_ENGLISH_TABLE`, else the packed payload `data/en/english.bin`.
pub fn english_table_path() -> Option<std::path::PathBuf> {
    if let Ok(path) = std::env::var("MURMO_ENGLISH_TABLE") {
        let p = std::path::PathBuf::from(path);
        if table_exists(&p) {
            return Some(p);
        }
    }
    if let Ok(root) = std::env::var("MURMO_PACKAGE_ROOT") {
        let p = std::path::Path::new(&root).join("data/en/english.bin");
        if table_exists(&p) {
            return Some(p);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        // payload/bin/<platform>/murmo-codex → payload/data/en/english.bin
        if let Some(payload) = exe
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
        {
            let p = payload.join("data/en/english.bin");
            if table_exists(&p) {
                return Some(p);
            }
        }
    }
    None
}

pub fn load_english_table() -> Option<(Vec<u8>, Value)> {
    let path = english_table_path()?;
    let bytes = std::fs::read(&path).ok()?;
    if bytes.len() < 32 {
        return None;
    }
    let entries = table_entries(&bytes)?;
    let sha = sha256_hex(&bytes);
    let lowercase: Value = std::env::var("MURMO_CASE_POLICY")
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(json!([]));
    let meta = json!({
        "sha256": sha,
        "entries": entries,
        "bytes": bytes.len(),
        "lowercaseOnly": lowercase,
        "asset": "english.bin",
    });
    Some((bytes, meta))
}

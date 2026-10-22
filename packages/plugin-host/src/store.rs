//! Store protocol on the supervisor: Claude sessions speak it over the helper
//! socket. Plugin `ctx.storage` still round-trips to the coordinator.

use std::env;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use murmo_store::protocol::Store;
use murmo_store::{roots_from_env, StoreRoots};
use serde_json::{json, Value};

/// The helper's `HOME`, `/` when unset (the store and config agree on it).
pub fn home_from_env() -> PathBuf {
    env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/"))
}

/// The store roots of this session: `MURMO_DATA`/`MURMO_STATE`/`MURMO_CACHE`, else XDG.
pub fn roots_from_process_env() -> StoreRoots {
    let home = home_from_env();
    let get = |name: &str| env::var(name).ok();
    StoreRoots {
        data: env::var("MURMO_DATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| roots_from_env(&get, &home).data),
        state: env::var("MURMO_STATE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| roots_from_env(&get, &home).state),
        cache: env::var("MURMO_CACHE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| roots_from_env(&get, &home).cache),
    }
}

pub fn open_from_env() -> Store {
    let private = env::var("MURMO_PRIVATE").ok().as_deref() == Some("1");
    Store::open(roots_from_process_env(), private)
}

pub fn handle(store: &Arc<Mutex<Option<Store>>>, message: &Value) -> Value {
    let mut guard = store.lock().expect("store");
    if guard.is_none() {
        *guard = Some(open_from_env());
    }
    match guard.as_mut() {
        Some(s) => s.handle(message),
        None => json!({"status": "error", "reason": "store unavailable"}),
    }
}

pub fn is_store_op(op: &str) -> bool {
    matches!(
        op,
        "storage.get"
            | "storage.set"
            | "storage.delete"
            | "private.get"
            | "generation.get"
            | "words.add"
            | "log.append"
    )
}

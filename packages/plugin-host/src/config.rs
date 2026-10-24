//! `config.load` for Claude sessions (phase 14: the project file goes through
//! the helper). Claude's plugin runtime has no lstat, realpath, O_NOFOLLOW or
//! device and inode, so the trust check that decides which project shortcuts
//! load runs here, in `murmo-config`, the Rust twin of `@murmo/config/node`
//! that `tools/config-parity.mjs` holds to the same results.

use std::env;
use std::path::Path;

use murmo_config::load::stamp_of;
use murmo_config::{load_session_config, user_config_path};
use murmo_store::StoreLayout;
use serde_json::{json, Value};

use crate::store::{home_from_env, roots_from_process_env};

pub fn is_config_op(op: &str) -> bool {
    op == "config.load"
}

/// `{op:"config.load", cwd}` → `{status:"ok", session, stamps}`: `session` is
/// the JSON of the JS `SessionConfig` without its stamps (user file, project
/// snapshot, trust state and the merged effective config), `stamps` the
/// `[path, stamp]` of every file the load read. With `since`, an earlier
/// reply's `stamps`, those files are checked first, one lstat each, and the
/// answer is `{status:"ok", unchanged:true}` when none changed: the idle
/// re-check a running Claude session sends.
pub fn handle(q: &Value) -> Value {
    let Some(cwd) = q
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|cwd| Path::new(cwd).is_absolute())
    else {
        return json!({"status": "error", "kind": "transport", "error": "config.load needs an absolute cwd"});
    };
    if q.get("since").is_some_and(|since| !changed(since)) {
        return json!({"status": "ok", "unchanged": true});
    }
    let get = |name: &str| env::var(name).ok();
    let user = user_config_path(&get, &home_from_env());
    let layout = StoreLayout::new(roots_from_process_env());
    match load_session_config(Path::new(cwd), &user, &layout) {
        Ok(session) => {
            let stamps: Vec<Value> = session
                .stamps
                .iter()
                .map(|s| json!([s.path.to_string_lossy(), s.stamp]))
                .collect();
            json!({"status": "ok", "session": session.to_json(), "stamps": stamps})
        }
        Err(error) => json!({"status": "error", "kind": "transport", "error": error.to_string()}),
    }
}

/// True unless `since` is a well-formed stamp list whose files all look the same.
fn changed(since: &Value) -> bool {
    let Some(stamps) = since.as_array() else {
        return true;
    };
    stamps.iter().any(|entry| {
        match (
            entry.get(0).and_then(Value::as_str),
            entry.get(1).and_then(Value::as_str),
        ) {
            (Some(path), Some(stamp)) => stamp_of(Path::new(path)).stamp != stamp,
            _ => true,
        }
    })
}

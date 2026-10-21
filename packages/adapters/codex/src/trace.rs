//! Optional JSONL trace (`MURMO_TRACE`). Never logs draft secrets in full in
//! production; tests opt in.

use std::env;
use std::fs::OpenOptions;
use std::io::Write;

use serde_json::Value;

pub fn emit(v: &Value) {
    let Ok(path) = env::var("MURMO_TRACE") else {
        return;
    };
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{v}");
    }
}

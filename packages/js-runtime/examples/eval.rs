//! Loads an IIFE bundle and calls one exported function with a JSON argument.
//! Used by `tools/test-portable.mjs` to compare this engine with QuickJS-wasm,
//! and by the conformance runner as its rquickjs launcher (docs/plan/02).
//!
//!   eval <bundle.js> <Global.function> <json-arg | @file> [budget-ms]
//!
//! `@file` reads the argument from a file (fixture suites are too large for a
//! command line); `budget-ms` replaces the default 5 s interrupt budget.

use std::time::Duration;

use murmo_js_runtime::{Engine, Limits};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (bundle, function, arg, budget_ms) = match args.as_slice() {
        [_, bundle, function, arg] => (bundle, function, arg, "5000"),
        [_, bundle, function, arg, budget] => (bundle, function, arg, budget.as_str()),
        _ => usage(),
    };
    let Ok(budget_ms) = budget_ms.parse::<u64>() else {
        usage()
    };
    let source = read(bundle);
    let arg = match arg.strip_prefix('@') {
        Some(file) => read(file),
        None => arg.clone(),
    };
    let engine = Engine::new(Limits {
        memory_bytes: 32 << 20,
        stack_bytes: 512 << 10,
    })
    .expect("engine");
    let budget = Duration::from_millis(budget_ms);
    let result = engine
        .load_script(&source, budget)
        .and_then(|()| engine.call_json(function, &arg, budget));
    match result {
        Ok(json) => println!("{json}"),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}

fn usage() -> ! {
    eprintln!("usage: eval <bundle.js> <Global.function> <json-arg | @file> [budget-ms]");
    std::process::exit(2);
}

fn read(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| {
        eprintln!("{path}: {e}");
        std::process::exit(2);
    })
}

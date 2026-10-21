//! Loads an IIFE bundle and calls one exported function with a JSON argument.
//! Used by `tools/test-portable.mjs` to compare this engine with QuickJS-wasm.
//!
//!   eval <bundle.js> <Global.function> <json-arg>

use std::time::Duration;

use murmo_js_runtime::{Engine, Limits};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let [_, bundle, function, arg] = args.as_slice() else {
        eprintln!("usage: eval <bundle.js> <Global.function> <json-arg>");
        std::process::exit(2);
    };
    let source = std::fs::read_to_string(bundle).unwrap_or_else(|e| {
        eprintln!("{bundle}: {e}");
        std::process::exit(2);
    });
    let engine = Engine::new(Limits {
        memory_bytes: 32 << 20,
        stack_bytes: 512 << 10,
    })
    .expect("engine");
    let budget = Duration::from_secs(5);
    let result = engine
        .load_script(&source, budget)
        .and_then(|()| engine.call_json(function, arg, budget));
    match result {
        Ok(json) => println!("{json}"),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}

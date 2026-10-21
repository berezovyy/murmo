//! Drives the Rust store from tests (`tools/store-parity.mjs`), so Node and
//! Rust writers can be mixed on one store.
//!
//!   store-tool <data> <state> <cache> handle            JSON request per stdin line, reply per stdout line
//!   store-tool <data> <state> <cache> sets <plugin> <prefix> <keys> <rounds>
//!                                                       `rounds` passes over keys `<prefix>-0..<keys>`, value = round
//!   store-tool <data> <state> <cache> write-loop <kind> writes records of `kind` until killed

use std::io::{BufRead, Write};
use std::path::PathBuf;

use murmo_store::protocol::Store;
use murmo_store::record::{update_record, Change, UpdateOptions, Updated};
use murmo_store::records::RecordKind;
use murmo_store::StoreRoots;
use serde_json::{json, Map, Value};

fn usage() -> ! {
    eprintln!("usage: store-tool <data> <state> <cache> (handle | sets <plugin> <prefix> <keys> <rounds> | write-loop <kind>)");
    std::process::exit(2);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 5 {
        usage();
    }
    let roots = StoreRoots {
        data: PathBuf::from(&args[1]),
        state: PathBuf::from(&args[2]),
        cache: PathBuf::from(&args[3]),
    };
    let mut store = Store::open(roots, false);
    match (args[4].as_str(), &args[5..]) {
        ("handle", []) => {
            let stdin = std::io::stdin();
            let mut out = std::io::stdout().lock();
            for line in stdin.lock().lines() {
                let line = line.expect("stdin");
                let reply = match serde_json::from_str::<Value>(&line) {
                    Ok(request) => store.handle(&request),
                    Err(_) => json!({ "status": "error", "reason": "malformed store request" }),
                };
                writeln!(out, "{reply}").expect("stdout");
                out.flush().expect("stdout");
            }
        }
        ("sets", [plugin, prefix, keys, rounds]) => {
            let keys: u32 = keys.parse().unwrap_or_else(|_| usage());
            let rounds: u32 = rounds.parse().unwrap_or_else(|_| usage());
            for round in 0..rounds {
                for k in 0..keys {
                    let request = json!({ "op": "storage.set", "plugin": plugin, "key": format!("{prefix}-{k}"), "value": round });
                    let reply = store.handle(&request);
                    if reply["status"] != "ok" {
                        eprintln!("set failed: {reply}");
                        std::process::exit(1);
                    }
                }
            }
        }
        ("write-loop", [kind]) => write_loop(&store, kind),
        _ => usage(),
    }
}

/// Rewrites one record of `kind` forever, each version valid, for the SIGKILL test.
fn write_loop(store: &Store, kind: &str) -> ! {
    let layout = &store.layout;
    let (record_kind, path) = match kind {
        "trust" => (RecordKind::Trust, layout.trust.clone()),
        "words" => (RecordKind::Words, layout.words.clone()),
        "plugin" => (RecordKind::Plugin, layout.plugin_record("crash")),
        "meta" => (RecordKind::Meta, layout.meta.clone()),
        _ => usage(),
    };
    let mut repairs = murmo_store::files::ModeRepairs::default();
    let options = UpdateOptions {
        durable: kind == "trust" || kind == "words",
        ..UpdateOptions::new(&layout.roots.data)
    };
    for n in 0u64.. {
        let outcome = update_record(record_kind, &path, &options, &mut repairs, |_| {
            Change::Write(sample(kind, n), ())
        });
        if let Updated::Error(reason) = outcome {
            eprintln!("{reason}");
            std::process::exit(1);
        }
    }
    unreachable!()
}

/// A valid record of `kind` whose size changes with `n`.
fn sample(kind: &str, n: u64) -> Map<String, Value> {
    let id = murmo_store::sha256_hex(&n.to_le_bytes());
    let value = match kind {
        "trust" => json!({ "schema": 1, "approvals": { id.clone(): {
            "projectId": id, "root": "/r", "dev": "1", "ino": n.to_string(), "fingerprint": id,
            "approvedAt": n, "shortcutCount": n % 1000 } } }),
        "words" => {
            json!({ "schema": 1, "words": (0..(n % 500)).map(|i| format!("w{i}")).collect::<Vec<_>>() })
        }
        "plugin" => {
            json!({ "schema": 1, "plugin": "crash", "data": { "n": n, "pad": "x".repeat((n % 4000) as usize) } })
        }
        _ => json!({ "schema": 1, "epoch": &id[..32], "generation": n }),
    };
    match value {
        Value::Object(map) => map,
        _ => unreachable!(),
    }
}

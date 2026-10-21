//! The Rust side of `tools/config-parity.mjs`.
//!
//!   config-parity parse                  stdin {"cases":[{"name","source","file","origin"}]}
//!                                        stdout [{"name","toml","config"}]
//!   config-parity session <cwd> <user-file> <data> <state> <cache>
//!                                        stdout the session config as JSON

use std::io::Read;
use std::path::PathBuf;

use murmo_config::schema::{parse_config, Origin};
use murmo_config::source::normalize_toml;
use murmo_store::{StoreLayout, StoreRoots};
use serde_json::{json, Map, Value as Json};

fn usage() -> ! {
    eprintln!("usage: config-parity (parse | session <cwd> <user-file> <data> <state> <cache>)");
    std::process::exit(2);
}

/// The parsed TOML as JSON, for comparing values across parsers.
fn toml_json(value: &toml::Value) -> Json {
    match value {
        toml::Value::String(s) => json!(s),
        toml::Value::Integer(i) if i.unsigned_abs() < 1u64 << 53 => json!(i),
        toml::Value::Integer(i) => json!({ "$bigint": i.to_string() }),
        toml::Value::Float(f) => serde_json::Number::from_f64(*f).map_or(Json::Null, Json::Number),
        toml::Value::Boolean(b) => json!(b),
        toml::Value::Datetime(_) => json!({ "$datetime": true }),
        toml::Value::Array(a) => Json::Array(a.iter().map(toml_json).collect()),
        toml::Value::Table(t) => Json::Object(
            t.iter()
                .map(|(k, v)| (k.clone(), toml_json(v)))
                .collect::<Map<_, _>>(),
        ),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("parse") => {
            let mut input = String::new();
            std::io::stdin().read_to_string(&mut input).expect("stdin");
            let request: Json = serde_json::from_str(&input).expect("JSON request");
            let mut out = Vec::new();
            for case in request["cases"].as_array().expect("cases") {
                let source = case["source"].as_str().expect("source");
                let origin = if case["origin"] == "project" {
                    Origin::Project
                } else {
                    Origin::User
                };
                let file = case["file"].as_str().expect("file");
                let config = parse_config(source, file, origin);
                // Files refused before parsing never reach a parser.
                let refused = config
                    .diagnostics
                    .iter()
                    .any(|d| d.code == "too-large" || d.code == "too-deep");
                let toml = if refused {
                    None
                } else {
                    normalize_toml(source)
                        .parse::<toml::Table>()
                        .ok()
                        .map(|t| toml_json(&toml::Value::Table(t)))
                };
                out.push(json!({ "name": case["name"], "toml": toml, "config": config.to_json() }));
            }
            println!("{}", Json::Array(out));
        }
        Some("session") => {
            let [_, _, cwd, user, data, state, cache] = args.as_slice() else {
                usage()
            };
            let layout = StoreLayout::new(StoreRoots {
                data: PathBuf::from(data),
                state: PathBuf::from(state),
                cache: PathBuf::from(cache),
            });
            match murmo_config::load_session_config(
                &PathBuf::from(cwd),
                &PathBuf::from(user),
                &layout,
            ) {
                Ok(session) => println!("{}", session.to_json()),
                Err(e) => {
                    eprintln!("{e}");
                    std::process::exit(1);
                }
            }
        }
        _ => usage(),
    }
}

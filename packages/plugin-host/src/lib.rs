//! Isolated plugin host: supervisor, worker, protocol, HTTP socket, store, config.

pub mod config;
pub mod cpu;
pub mod faults;
pub mod git;
pub mod http;
pub mod limits;
pub mod listing;
pub mod names;
pub mod network;
pub mod protocol;
pub mod sandbox;
pub mod store;
pub mod supervisor;
pub mod worker;

use std::env;

/// Binary entry used by `main` and by tests that want the same dispatch.
pub fn run() {
    let args: Vec<String> = env::args().collect();
    if args.iter().any(|a| a == "--sandbox-probe") {
        let canary = args
            .iter()
            .position(|a| a == "--canary")
            .and_then(|i| args.get(i + 1))
            .cloned()
            .unwrap_or_default();
        let port = args
            .iter()
            .position(|a| a == "--port")
            .and_then(|i| args.get(i + 1))
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        if args.iter().any(|a| a == "--apply") {
            if let Err(e) = sandbox::apply_linux() {
                println!("{{\"error\":{e:?}}}");
                return;
            }
        }
        println!("{}", sandbox::run_probes(&canary, port));
        return;
    }
    if args.iter().any(|a| a == "--worker") {
        if args.iter().any(|a| a == "--sandbox") {
            if let Err(e) = sandbox::apply_linux() {
                eprintln!("{e}");
                std::process::exit(2);
            }
        }
        worker::run();
        return;
    }
    if args.iter().any(|a| a == "--http") {
        let socket = args
            .iter()
            .position(|a| a == "--socket")
            .and_then(|i| args.get(i + 1))
            .cloned()
            .expect("--http requires --socket PATH");
        http::serve(socket);
        return;
    }
    let supervisor = supervisor::Supervisor::new();
    supervisor::serve_stdio(&supervisor);
}

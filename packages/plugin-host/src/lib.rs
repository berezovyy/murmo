//! Isolated plugin host: supervisor, worker, protocol, HTTP socket, store.

pub mod cpu;
pub mod faults;
pub mod http;
pub mod limits;
pub mod protocol;
pub mod store;
pub mod supervisor;
pub mod worker;

use std::env;

/// Binary entry used by `main` and by tests that want the same dispatch.
pub fn run() {
    let args: Vec<String> = env::args().collect();
    if args.iter().any(|a| a == "--worker") {
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

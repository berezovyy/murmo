//! Codex adapter: a PTY wrapper around the stock `codex` binary.
//!
//! Rust owns the terminal (bytes, screen, transport). One JavaScript bundle
//! (core, inline rules, built-ins) runs in rquickjs so the policy cannot drift
//! from the other hosts (lesson 57). Anything unrecognized is skipped.

pub mod args;
pub mod decoder;
pub mod draft;
pub mod engine;
pub mod forward;
pub mod helper;
pub mod hooks;
pub mod keys;
pub mod overlay;
pub mod probes;
pub mod pty;
pub mod screen;
pub mod session;
pub mod trace;
pub mod transport;

/// Recursion guard: the child `codex` must not be this wrapper again (lesson 40).
pub const RECURSION_GUARD: &str = "MURMO_CODEX_WRAP";

/// Packet scalar cap (lesson 38): Codex hides pastes over 1,000 Unicode
/// characters; 800 leaves headroom. ASCII 800 scalars bind before the 900-byte
/// packet cap, so the adapter reports `inline.maxBytes: 800` (phase 03 hand-off).
pub const PACKET_SCALAR_CAP: usize = 800;
pub const PACKET_BYTE_CAP: usize = 900;
pub const INLINE_MAX_BYTES: u32 = 800;
pub const STATUS_MAX_LENGTH: usize = 99;
pub const ENGINE_MEMORY_BYTES: usize = 16 * 1024 * 1024;
pub const ENGINE_STACK_BYTES: usize = 256 * 1024;
/// Wall budget for one guest entry on the key path (lesson 46).
pub const KEY_BUDGET_MS: u64 = 5;
pub const ESCAPE_TIMEOUT_MS: u64 = 15;
pub const SUBMIT_WAIT_MS: u64 = 55;
pub const ECHO_WAIT_MS: u64 = 250;
/// Codex `LARGE_PASTE_CHAR_THRESHOLD`.
pub const OPAQUE_PASTE_CHARS: usize = 1000;

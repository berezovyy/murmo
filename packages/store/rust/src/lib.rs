//! Murmo's store in Rust, for the helper (phase 10) and the Codex wrapper.
//!
//! It writes the same files as `@murmo/store/node`: the same layout, 0700/0600
//! modes, temp names, `<file>.lock` protocol and record shapes, so a Node
//! session, the helper and the Codex wrapper share one store and exclude each
//! other while writing. `protocol::handle` answers the store protocol Claude
//! sessions speak to the helper (`packages/store/src/protocol.ts`).

pub mod files;
pub mod identity;
pub mod layout;
pub mod lock;
pub mod logs;
pub mod namespace;
pub mod protocol;
pub mod record;
pub mod records;

pub use identity::{find_repository_root, project_id_of, project_identity, ProjectIdentity};
pub use layout::{roots_from_env, StoreLayout, StoreRoots};

use sha2::{Digest, Sha256};

/// Lowercase hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// Random lowercase hex from the OS (temp names, lock tokens).
pub(crate) fn random_hex(bytes: usize) -> std::io::Result<String> {
    use std::io::Read;
    let mut buf = vec![0u8; bytes];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut buf)?;
    Ok(hex(&buf))
}

/// Wall-clock milliseconds.
pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

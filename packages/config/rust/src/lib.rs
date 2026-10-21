//! The Rust twin of `@murmo/config` for the helper and the Codex wrapper.
//!
//! Each module ports the JS module of the same name in `packages/config/src`
//! and must give the same result and the same diagnostics for every fixture;
//! `tools/config-parity.mjs` checks that on the TOML corpus, the hostile
//! cases and the trust cases. The one allowed difference is a parse error's
//! wording and column, which come from each parser (smol-toml, `toml`).

pub mod diagnostics;
pub mod limits;
pub mod load;
pub mod merge;
pub mod reader;
pub mod references;
pub mod schema;
pub mod source;
pub mod text_policy;
pub mod trust;

pub use diagnostics::{Diagnostic, Position, Severity};
pub use load::{
    load_session_config, load_user_config, scan_project, user_config_path, ProjectSnapshot,
    SessionConfig, TrustState,
};
pub use merge::{merge_config, EffectiveConfig};
pub use references::{resolve_shortcuts, LoadedConfig};
pub use schema::{parse_config, ConfigFile, Origin};

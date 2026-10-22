//! Packed names-v1 index: search always; tree-sitter extract behind `extract`.
//!
//! The on-disk format matches r13 (`0x4d55524d`, u32 postings). Native search
//! was measured on this layout; a cap is applied only to an optional hot cache,
//! never to the file (lesson 29 / E3).

pub mod exclude;
pub mod packed;
pub mod record;
pub mod search;
pub mod split;

#[cfg(feature = "extract")]
pub mod extract;
#[cfg(feature = "extract")]
pub mod git;
#[cfg(feature = "extract")]
pub mod incremental;
#[cfg(feature = "extract")]
pub mod lock;
#[cfg(feature = "extract")]
pub mod regex_scan;
#[cfg(feature = "extract")]
pub mod snapshot;

pub use packed::{build_packed, PackedIndex, INDEXER_VERSION, NAMES_BIN, NAMES_MAGIC};
pub use record::NameRecord;
pub use search::{SearchAnswer, SearchStatus, NATIVE_BUDGET_US, NATIVE_CANDIDATES};
pub use split::{split_words, word_key};

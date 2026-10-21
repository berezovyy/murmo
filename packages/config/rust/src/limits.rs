//! The numbers of `src/limits.ts`; the parity runner fails when the two disagree.

pub const SHORTCUTS_PER_FILE: usize = 1000;
pub const SHORTCUT_CODE_POINTS: usize = 32;
pub const EXPANSION_BYTES: usize = 16_384;
pub const REFERENCE_BYTES: u64 = 16_384;
pub const CONFIG_FILE_BYTES: usize = 262_144;
pub const SNAPSHOT_BYTES: u64 = 1_048_576;
pub const SNAPSHOT_READS: u32 = 128;
pub const NESTING_DEPTH: usize = 32;
pub const WORD_CODE_POINTS: usize = 64;
pub const EXCERPT_CODE_POINTS: usize = 120;

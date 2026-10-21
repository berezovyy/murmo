//! Resource limits for one guest. Numbers are the draft 2.0-pre initial
//! defaults (`@murmo/api` LIMITS), not calibrated production budgets.

use std::time::Duration;

/// JS stack: `api.md` says 256 KiB; the r11b helper used 512 KiB. A recursion
/// fixture (tests/limits.rs) reaches >200 frames at 256 KiB, which is more
/// than any plugin hook needs, so we keep the published 256 KiB.
pub const STACK_BYTES: usize = 256 * 1024;
pub const DEFAULT_MEMORY_MIB: u64 = 8;
pub const MAX_MEMORY_MIB: u64 = 128;
pub const SOURCE_BYTES: usize = 1_048_576;
pub const ASSET_BYTES: usize = 4_194_304;
pub const RESPONSE_BYTES: usize = 65_536;
pub const EFFECTS_PER_CALL: usize = 128;
pub const INIT_INTERRUPT_MS: u64 = 100;
pub const INIT_WAIT_MS: u64 = 500;
pub const DEFAULT_SLICE_MS: u64 = 5;
pub const WATCHDOG_GRACE_MS: u64 = 50;
pub const MAX_LINE_BYTES: usize = 12 * 1024 * 1024;
pub const PROTOCOL: u32 = 1;
pub const API_VERSION: &str = "2.0.0";

pub fn memory_bytes(mib: u64) -> usize {
    (mib as usize).saturating_mul(1024 * 1024)
}

pub fn slice_duration(ms: u64) -> Duration {
    Duration::from_millis(ms.clamp(1, 100))
}

pub fn deadline_duration(ms: u64) -> Duration {
    Duration::from_millis(ms.clamp(1, 8_000))
}

pub fn watchdog_ms(deadline_ms: u64) -> u64 {
    deadline_ms
        .saturating_add(WATCHDOG_GRACE_MS)
        .clamp(1, 10_000)
}

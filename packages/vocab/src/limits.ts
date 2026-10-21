// Build and table caps (docs/plan/19). File/byte limits stop a huge repo; the
// 1 MiB protection cap is the hard ceiling on what a session will map.

/** Bump when limits change; part of the protection cache key. */
export const LIMITS_VERSION = 1;

export const MAX_TRACKED_FILES = 20_000;
export const MAX_READ_BYTES = 64 * 1024 * 1024;
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_PROTECT_BYTES = 1024 * 1024;
export const IDLE_CHECK_MS = 10 * 60 * 1000;
export const EXTRACTOR_VERSION = 2;

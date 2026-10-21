// Config limits. The Rust twin (packages/config/rust/src/limits.rs) carries the
// same numbers; the parity runner fails when the two disagree on a fixture.

export const CONFIG_LIMITS = {
  /** `[replace]` entries per file (02-architecture § Loading and failures). */
  shortcutsPerFile: 1000,
  /** Code points in one shortcut. */
  shortcutCodePoints: 32,
  /** UTF-8 bytes of one expansion, inline or from a referenced file. */
  expansionBytes: 16_384,
  /** UTF-8 bytes of a referenced file, read before the one trailing newline is dropped. */
  referenceBytes: 16_384,
  /** One `murmo.toml` or `.murmo.toml`; bigger is refused before parsing (r12 K2, K3). */
  configFileBytes: 262_144,
  /** Config plus referenced bytes read for one project snapshot (r12 K2 broker default). */
  snapshotBytes: 1_048_576,
  /** Files read for one project snapshot, the config included (r12 K2 broker default). */
  snapshotReads: 128,
  /** Array and inline-table nesting; deeper files are refused before parsing (r12 K3). */
  nestingDepth: 32,
  /** Code points in one protected word. */
  wordCodePoints: 64,
  /** Code points of source shown in a diagnostic excerpt. */
  excerptCodePoints: 120,
} as const;

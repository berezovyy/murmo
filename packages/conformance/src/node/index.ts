// Node-only parts of @murmo/conformance: the fixture reader, the runtime
// launchers, failure shrinking, and the CLI's JSONL helpers.

export { fromJsonl, toJsonl } from './cli.ts';
export {
  fixturesDir,
  loadFixtureDir,
  readFixtureSource,
  repoRoot,
  saveRegression,
  stringifyFixture,
} from './fixtures.ts';
export { createIsolatedCoreSubject } from './isolated-subject.ts';
export {
  buildGuest,
  bunAvailable,
  bunCommand,
  type CoreRuntimeName,
  coreBudgetMs,
  coreRuntimes,
  guestBudgetMs,
  guestGlobal,
  type LaunchOptions,
  launch,
  launchCore,
  pureSuites,
  type RuntimeName,
  runtimes,
} from './launchers.ts';
export { type SavedRegression, saveFailures, streamIndex } from './regressions.ts';
export { type RustTextParity, runRustTextParity } from './rust-text.ts';

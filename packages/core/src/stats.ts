// Counters every module adds to, and the health report built from them. The
// numbers are what fixtures and `murmo doctor` read; plugin health is reported
// apart from `ready`, because a session once looked healthy while a plugin
// was disabled for good and after its helper was killed (lessons 71, 76).

import type { ResultCode } from '@murmo/api';
import type { RunnerHealth } from './hooks.ts';

export type DecisionBy = 'native' | 'undo' | 'menu' | 'claim' | 'none';

export type Surface = 'ghost' | 'highlight' | 'status' | 'menu';

export const resultCodes: readonly ResultCode[] = [
  'applied',
  'stale',
  'denied',
  'unsupported',
  'invalid-range',
  'cancelled',
  'error',
];

const tally = (): Record<ResultCode, number> =>
  Object.fromEntries(resultCodes.map((code) => [code, 0])) as Record<ResultCode, number>;

export class Counters {
  keys = 0;
  /** Changes published to plugins. */
  changes = 0;
  /** Of those, caused by the session's own commits and restores. */
  ownChanges = 0;
  /** Effects dropped as stale before they reached the adapter (lesson 17: dropped, never queued). */
  staleEffects = 0;
  /** Effects refused before the adapter: not editable, not permitted, unsafe text, a commit gate. */
  deniedEffects = 0;
  /** Effects the host can't show or apply (capabilities). */
  unsupportedEffects = 0;
  /** Malformed results: not an effect list, unknown effect types, bad ranges, too many effects. */
  invalidEffects = 0;
  /** Edit commits by result, counting the adapter's answers and the session's own refusals. */
  readonly commits = tally();
  restores = 0;
  /** Restores whose committed snapshot differed from the saved draft (an adapter that breaks `exactRestore`). */
  restoreMismatches = 0;
  /** Adapter presentation calls by surface and result. */
  readonly ui: Record<Surface, Record<ResultCode, number>> = {
    ghost: tally(),
    highlight: tally(),
    status: tally(),
    menu: tally(),
  };
  /** Key-router decisions per `by` (native UI, undo, menu, claim, or nobody). */
  readonly keyBy: Record<DecisionBy, number> = { native: 0, undo: 0, menu: 0, claim: 0, none: 0 };
  /** Errors thrown inside session callbacks or tasks (the fail-open guard's count). */
  failures = 0;
  /** Plugin hook faults. */
  faults = 0;
  /** Send/queue/steer attempts that reached the pipeline (not newline, not a menu dismiss). */
  submits = 0;
  /** Pipeline blocks that counted as a refused send (not a menu dismiss). */
  blocked = 0;
  lastBlockReason: string | undefined;
  /** Committed events delivered (`observed` or `inferred`). */
  committed = 0;
  /** Forwards that ended `unknown`; observers got `onSubmitUnresolved`. */
  unresolved = 0;
  /** Oldest committed/unresolved events dropped from a full observer queue. */
  observerOverflow = 0;
  /** Last commit-gate denial reason (`submit-in-progress`, …). */
  lastDeniedReason: string | undefined;
  /** Typo and shortcut corrections the inline interpreter committed (phase 07). */
  inlineCorrections = 0;
  /** Shortcut expansions that landed (phase 15). Counts only; names live in `shortcutByName`. */
  shortcutExpanded = 0;
  /** Immediate Backspace or Murmo undo of a shortcut expansion (roadmap metric). */
  shortcutUndone = 0;
}

export interface PluginHealth {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly builtin: boolean;
  readonly activated: boolean;
  readonly disabled: boolean;
  readonly loaded: boolean;
  readonly strikes: number;
  readonly denied: number;
  /** Why it was disabled. */
  readonly reason?: string;
}

export interface SessionStats {
  /** Subscribed to the adapter. Not a health claim: see `plugins`, `disabled` and `executor`. */
  readonly ready: boolean;
  readonly disposed: boolean;
  /** The fail-open guard turned the session off. */
  readonly killed: boolean;
  readonly executor: RunnerHealth;
  readonly plugins: readonly PluginHealth[];
  readonly disabled: readonly string[];
  readonly notices: readonly string[];
  readonly epoch: number;
  readonly version: number;
  readonly undoDepth: number;
  /** Ledgers that did not add up and were resynced from the adapter. */
  readonly resyncs: number;
  /** Changes whose ledger was verified (`before` plus ordered deltas give the reported draft). */
  readonly ledgerChecks: number;
  readonly keys: number;
  readonly keyBy: Readonly<Record<DecisionBy, number>>;
  readonly changes: number;
  readonly ownChanges: number;
  /** All stale drops: stale effects plus `stale` and `cancelled` commits. */
  readonly stale: number;
  /** All refusals: denied effects plus `denied` commits. */
  readonly denied: number;
  readonly unsupported: number;
  readonly invalid: number;
  /** Edits the host committed. */
  readonly applied: number;
  readonly commits: Readonly<Record<ResultCode, number>>;
  readonly restores: number;
  readonly restoreMismatches: number;
  readonly ui: Readonly<Record<Surface, Readonly<Record<ResultCode, number>>>>;
  readonly failures: number;
  readonly faults: number;
  readonly submits: number;
  readonly blocked: number;
  readonly lastBlockReason?: string;
  readonly committed: number;
  readonly unresolved: number;
  readonly observerOverflow: number;
  readonly lastDeniedReason?: string;
  /** Inline typo/shortcut corrections that landed (phase 07). */
  readonly inlineCorrections: number;
  /** Shortcut expansions that landed (phase 15). */
  readonly shortcutExpanded: number;
  /** Shortcut expansions reverted by immediate Backspace or Murmo undo. */
  readonly shortcutUndone: number;
  /** Per shortcut name (a config key), counts only: never expansion or draft text. */
  readonly shortcutByName: Readonly<Record<string, { readonly expanded: number; readonly undone: number }>>;
}

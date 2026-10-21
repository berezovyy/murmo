import type { EditorCase, GeneratorFile, PureCase } from '@murmo/fixtures';

export type CaseKind = 'editor-ops' | 'pure-fn';

/**
 * What a subject can run. `features` holds capability paths a case can
 * require (`executor.isolated`, `ui.dialogSafe`, `fn.names.splitWords`); an
 * unmet requirement skips the run with its reason, never passes it.
 */
export interface Capabilities {
  kinds: CaseKind[];
  /** Executors each case runs under; the pure subject has one, `none`. */
  executors: string[];
  /** Trust levels the subject can load plugins with. */
  trust: ('builtin' | 'third-party')[];
  features: Record<string, string | number | boolean>;
}

/** One run: a case after defaults, variant and trust level are applied. */
export interface Run {
  suite: string;
  kind: CaseKind;
  caseId: string;
  variant?: string;
  /** Absent for pure-fn runs, which load no plugins. */
  trust?: 'builtin' | 'third-party';
  executor: string;
  /** The suite's owning phases, for skip reasons. */
  owner: string;
  case: EditorCase | PureCase;
  seed?: number;
  /** Runs with the same key share one session, in order (generator `session: "shared"`). */
  session?: string;
  skip?: { reason: string; declared: boolean };
}

export interface Assertion {
  what: string;
  ok: boolean;
  expected?: unknown;
  actual?: unknown;
  /** A timing assertion: gates only when timing gates are on (nightly); otherwise reported. */
  timing?: boolean;
}

export interface Observed {
  assertions: Assertion[];
  /** Hash of a pure function's result, compared across runtimes. */
  outputHash?: string;
  timing?: Record<string, number>;
  measure?: Record<string, number>;
}

export interface Subject {
  name: string;
  caps(): Capabilities;
  run(run: Run): Promise<Observed>;
  dispose(): Promise<void>;
}

export type Status = 'pass' | 'fail' | 'skip';

/** One JSON line per run (docs/plan/02 § Verdicts). */
export interface Verdict {
  suite: string;
  case: string;
  variant?: string;
  subject: string;
  runtime: string;
  executor: string;
  trust?: 'builtin' | 'third-party';
  status: Status;
  reason?: string;
  /** The skip was declared in the case (reviewed), not caused by a missing capability. */
  declared?: boolean;
  assertions: number;
  ms: number;
  seed?: number;
  outputHash?: string;
  timing?: Record<string, number>;
  measure?: Record<string, number>;
}

/** A fixture file after loading: defaults merged, tables resolved, declared sizes attached. */
export type LoadedSuite =
  | {
      kind: 'editor-ops';
      file: string;
      owner: string;
      declared: { cases: number; variants: number };
      cases: EditorCase[];
    }
  | {
      kind: 'pure-fn';
      file: string;
      owner: string;
      declared: { cases: number };
      cases: PureCase[];
    }
  | { kind: 'generator'; file: string; owner: string; generator: GeneratorFile };

export interface RunOptions {
  runtime: string;
  /** PR runs use the generators' `pr` size; nightly runs use `nightly`. */
  mode: 'pr' | 'nightly';
  /** Timing assertions fail a run only when gated (nightly, on a quiet machine). */
  timing: 'gate' | 'report';
  now: () => number;
}

export interface RunResult {
  verdicts: Verdict[];
}

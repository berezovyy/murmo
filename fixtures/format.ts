// The shared fixture format (docs/plan/02 § Format). JSON files under fixtures/
// follow these types; fixtures/schema/*.json states the same rules for the
// validator, which checks every file before a run.
//
// Every range and cursor is in UTF-16 code units. Strings in files keep
// invisible characters (ZWJ, combining marks, bidi controls) as \u escapes.

/** Where an input came from. Provenance comes from the input path, never from the text (lesson 52). */
export type Origin = 'typed' | 'paste' | 'ime' | 'fill' | 'history' | 'native-menu' | 'plugin' | 'undo' | 'unknown';

export type Gesture = 'send' | 'queue' | 'steer' | 'newline';

export type EditorMode = 'insert' | 'normal' | 'visual' | 'replace' | 'unknown';

export interface HostState {
  mode: 'prose' | 'shell' | 'command' | 'unknown';
  popup: null | { owner: string };
  dialog: boolean;
  busy: boolean;
  editorMode: EditorMode;
  history: boolean;
}

/** Named host states, as the r14 `repeatStates` used them. */
export type StateName = 'busy' | 'popup' | 'dialog' | 'history' | 'vim-normal' | 'unknown';

/** Large text without a large file: `{repeat: 'ab', times: 3}` is `ababab`; an array concatenates. */
export type TextSpec = string | { repeat: string; times: number } | TextSpec[];

/** One splice inside a native transaction. Without `from`/`to` it inserts at the cursor. */
export interface BurstDelta {
  origin: Origin;
  text: TextSpec;
  from?: number;
  to?: number;
}

/** A state step's value: a partial state, a named state, or the variant being run. */
export type StateValue = Partial<HostState> | StateName | '$variant' | { editorMode: '$variant' };

export type RestartHow = 'kill' | 'term' | 'hangup';

export type Step =
  /** Typed key by key: one change per code point. */
  | { type: TextSpec }
  /** One native transaction with ordered deltas; `key` is the key id the host reports with it. */
  | { burst: BurstDelta[]; key?: string }
  /** Inserted at the cursor (replacing a selection) with origin `paste` or `ime`. */
  | { paste: TextSpec }
  | { ime: TextSpec }
  /** The whole draft replaced programmatically; origin defaults to `fill`. */
  | { fill: TextSpec; origin?: Origin; cursor?: number }
  /** The whole draft replaced by a history recall. */
  | { history: TextSpec }
  /** A canonical key ID (space, Tab, Enter, Backspace, F6, Up, …); `routing` is what it must get. */
  | { key: string; routing?: 'pass' | 'consume' }
  /** Moves the cursor to an absolute UTF-16 offset, without changing the text. */
  | { move: number }
  | { select: [number, number] }
  | { state: StateValue }
  | { submit: Gesture }
  /** Waits until every plugin task started so far has settled. */
  | { settle: true }
  | { waitMs: number }
  /**
   * The host ends the way a crash or exit does, then the same profile (home,
   * store, project) is launched again and the case goes on in the new
   * session. `kill` is SIGKILL, `term` SIGTERM, `hangup` the terminal closing
   * (PTY master closed). Real hosts only: needs `adapter.rescue`.
   */
  | { restart: RestartHow }
  /**
   * While the host runs, the user rewrites a config file outside it: `user`
   * is the personal murmo.toml, `project` the repository's .murmo.toml.
   * Real hosts only: needs `configFile`.
   */
  | { configFile: 'user' | 'project'; text: TextSpec }
  /** While the host runs, the user approves the project file with `murmo trust`. Needs `trust`. */
  | { trust: 'approve' }
  /** A checkpoint: these expectations must hold here. */
  | { check: Expect };

/** An exact count, or bounds. */
export type Count = number | { min?: number; max?: number };

/** The draft: its exact text, or (when a count of plugin insertions is timing-dependent) how it ends. */
export interface DraftExpect {
  text?: TextSpec;
  endsWith?: string;
  cursor?: number;
  selection?: [number, number];
  typedSpans?: [number, number][];
}

export interface UiExpect {
  ghost?: string | null;
  /** Menu item IDs in display order; `null` means no menu is shown. */
  menu?: string[] | null;
  /** The real owner ID of each menu row, in display order. */
  menuOwners?: string[];
  menuRows?: Count;
  status?: string | null;
  statusIncludes?: string | string[];
  statusLength?: Count;
  /** Surfaces that must hold no C0/C1 controls or bidi overrides. */
  safeText?: ('status' | 'menu' | 'ghost')[];
}

export interface Expect {
  draft?: DraftExpect;
  /** User text of each request the fake model received, in order. */
  requests?: TextSpec[];
  ui?: UiExpect;
  notices?: string[];
  stats?: Record<string, Count>;
  /** Plugins that must be disabled, and ones that must still be enabled. */
  disabled?: string[];
  enabled?: string[];
  /** Plugin edits the host applied, and who they were attributed to. */
  edits?: { applied?: Count; unattributed?: Count; attributedTo?: string[] };
  /** Substrings each plugin's stored data must, or must not, contain. */
  storage?: Record<string, { includes?: string[]; excludes?: string[] }>;
  /** Substrings that must never appear in a request, the draft or the status. */
  never?: { request?: string[]; draft?: string[]; status?: string[] };
  /** Delivery of the last key, minus the same-time control's, in milliseconds. */
  withinMs?: number;
  /** Replaces these fields for runs with the plugins as third-party (docs/plan/02 § Trust levels). */
  thirdParty?: Omit<Expect, 'thirdParty'>;
}

/** A plugin instance: a fixture or provided plugin by name, or with its own ID and settings. */
export type PluginRef = string | { id: string; plugin: string; settings?: Record<string, unknown> };

export type Trust = 'builtin' | 'third-party' | 'both';

/** A declared, reviewed skip. Every field present must match the run. */
export interface Skip {
  runtime?: string;
  executor?: string;
  subject?: string;
  trust?: 'builtin' | 'third-party';
  reason: string;
}

/** Fake-host setup: the measured quirks a case needs from the host. */
export interface HostSetup {
  guardPosition?: 'managed' | 'final-boundary';
  /** A native peer transform after (managed) or before (final boundary) our guard. */
  nativePeer?: 'inject-todo';
  /** Tab is the host's queue gesture (Codex). */
  tabQueues?: boolean;
  inputOriginEvidence?: 'host-labeled' | 'observed-unmarked' | 'unknown';
  dialogSafe?: boolean;
  /** Keys the host does not advertise as interceptable. */
  unadvertisedKeys?: string[];
  submitTransform?: boolean;
  /**
   * When the host runs a plugin commit (phase 05): `hold` until the next input
   * step has landed, `compete` with a change just before the version check,
   * `race` by typing `raceText` right after the commit applied.
   */
  commitTiming?: 'hold' | 'compete' | 'race';
  /** Typed by `race`, inserted by `compete`; one space by default. */
  raceText?: string;
  /** Every plugin commit, or every undo restore, returns this instead of applying. */
  commitStatus?: CommitFault;
  restoreStatus?: CommitFault;
  /** Edit capabilities over the reference adapter's (all true). */
  edit?: {
    atomic?: boolean;
    end?: boolean;
    middle?: boolean;
    multiline?: boolean;
    exactRestore?: boolean;
    attributed?: boolean;
  };
  /** The draft's certainty. */
  certainty?: 'authoritative' | 'tracked' | 'unknown';
}

export type CommitFault = 'stale' | 'cancelled' | 'denied' | 'invalid-range' | 'unsupported' | 'error';

export interface Timing {
  /** Each key's synchronous delivery, minus the same-time control's. */
  keyMs?: number;
  /** Each draft change the core processes, minus the control's. */
  changeMs?: number;
  /** Whole-case time at most `factor` × the named case's time in the same run. */
  baseline?: { case: string; factor: number };
}

/** A callback-latency sample series recorded in the verdict; reported, never asserted. */
export interface Measure {
  key: string;
  repeat: number;
  quantiles: number[];
  unit: 'us';
  scope: 'callback';
}

/** A plugin folder under fixtures/ (`murmo.plugin.json` plus its entry), added with these grants. */
export interface InstalledPlugin {
  folder: string;
  grants: string[];
  /** `false`: then turned off with `murmo plugin disable`. */
  enabled?: boolean;
}

export interface EditorCase {
  id: string;
  tags?: string[];
  note?: string;
  /** Capability paths (`a.b` or `a.b=value`); unmet means skip with the reason, never pass. */
  requires?: string[];
  plugins?: PluginRef[];
  grants?: Record<string, string[]>;
  /** Murmo settings (murmo.toml shape), e.g. `{autocorrect: {language: 'de'}}`. */
  settings?: Record<string, unknown>;
  /** A project folder under fixtures/, e.g. `shortcuts/replacements`. */
  project?: string;
  /** Whether the user approved `project`'s `.murmo.toml` (`murmo trust`) before the host starts. */
  projectTrust?: 'approved' | 'unreviewed';
  /**
   * The user's own host settings, from before Murmo was installed: a folder
   * under fixtures/ whose `<host>/` subfolder is copied into that host's
   * config folder (OpenCode's `cli.json`, Claude's `settings.json`, …).
   */
  hostConfig?: string;
  /** Plugins the user installed with `murmo plugin add` before the host starts. */
  installed?: InstalledPlugin[];
  trust?: Trust;
  host?: HostSetup;
  core?: { guardPolicy?: 'final-boundary' };
  /** `unsettled`: steps do not wait for plugin tasks (C3); `{settle: true}` waits explicitly. */
  pacing?: 'settled' | 'unsettled';
  variants?: { states?: StateName[]; editorModes?: EditorMode[] };
  /** Timing case: also run a same-time zero-plugin control (lesson 65). */
  control?: boolean;
  timing?: Timing;
  measure?: Measure;
  steps: Step[];
  expect: Expect;
  skip?: Skip[];
}

export interface Provenance {
  /** Where the cases came from: an experiment path, a report section, or "new". */
  source: string;
  license: string;
  author: string;
}

/** Fields an editor-ops file may set once for all its cases. */
export type CaseDefaults = Pick<
  EditorCase,
  'plugins' | 'trust' | 'pacing' | 'host' | 'settings' | 'project' | 'requires' | 'grants'
>;

export interface EditorOpsFile {
  kind: 'editor-ops/v1';
  offsets: 'utf16';
  provenance: Provenance;
  defaults?: CaseDefaults;
  cases: EditorCase[];
}

export interface PureCase {
  id: string;
  fn?: string;
  tags?: string[];
  note?: string;
  requires?: string[];
  input: unknown;
  /**
   * The expected result. Files always state it; a generated case may leave it
   * out, and then its result is only compared across runtimes (by hash).
   */
  output?: unknown;
  skip?: Skip[];
}

/** Cases stored in a moved file, read through named fields. */
export interface PureTable {
  file: string;
  cases: string;
  id?: string;
  input: string;
  output: string;
}

export interface PureFnFile {
  kind: 'pure-fn/v1';
  offsets: 'utf16';
  provenance: Provenance;
  fn?: string;
  cases?: PureCase[];
  table?: PureTable;
}

export type GeneratorName = 'burst' | 'unicode' | 'provenance' | 'ledger' | 'edits';

export interface GeneratorFile {
  kind: 'generator/v1';
  provenance: Provenance;
  generator: GeneratorName;
  seed: number;
  /** Streams per cohort: PR runs and the nightly job (docs/plan/02 § Sizes). */
  sizes: { pr: number; nightly: number };
  /** `shared`: every stream runs in one session, in order, as in rounds 13–14. */
  session: 'shared' | 'fresh';
  /** What runs the generated cases: an editor-ops subject, or a named pure function. */
  target:
    | { kind: 'editor-ops'; plugins?: PluginRef[]; trust?: Trust; host?: HostSetup; requires?: string[] }
    | { kind: 'pure-fn'; fn: string };
  /** Where a shrunk failing stream is saved as a fixed case. */
  failures: string;
  /** Counts a run of this size must reproduce. */
  reference?: { size: number; counts: Record<string, number>; source: string };
}

export interface MovedFile {
  kind: 'moved/v1';
  provenance: Provenance;
  files: { path: string; source: string; sha256: string; bytes: number }[];
}

export type FixtureFile = EditorOpsFile | PureFnFile | GeneratorFile | MovedFile;

/** fixtures/suites.json: every fixture file, its owner and its declared size (anti-vacuity). */
export interface SuiteIndex {
  kind: 'suites/v1';
  suites: {
    file: string;
    owner: string;
    /** Cases in the file; editor-ops and pure-fn only. */
    cases?: number;
    /** Runs after variant expansion, before executors and trust levels. */
    variants?: number;
  }[];
}

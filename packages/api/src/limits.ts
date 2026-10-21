// Version labels, permission names, deadlines and limits of the plugin API.
//
// Every number here is an initial default carried over from draft 2.0-pre
// (experiments/platform/shared-v2: api.md § Executors, MANIFEST.md, README.md,
// MIGRATION.md), not a calibrated production budget; phase 09 calibrates them.
// Values are written as literals so the API report (report/*.d.ts) shows them:
// changing one is a CHANGELOG entry, caught by the report gate.

/** The version manifests negotiate against (`api` ranges). Stays 2.0.0 until v1. */
export const API_VERSION = '2.0.0';

/**
 * The draft label shown to authors. Each breaking change before v1 bumps the
 * counter (`2.0-pre.1`, ...); scaffolds record it and `murmo plugin dev` warns
 * when it differs.
 */
export const API_DRAFT = '2.0-pre.0';

/**
 * Every permission a plugin can declare. A declaration is never a grant: the host
 * grants (see `PERMISSION_DEFAULTS` in `@murmo/api/adapter`).
 *
 * - `draft:read`: the draft with every non-typed UTF-16 unit masked (typed-only).
 * - `draft:read:full`: the whole draft, pasted text included.
 * - `submit:observe`: committed and unresolved send events, read-only.
 * - `draft:write`: versioned edits, ghosts, menus with edits.
 * - `submit`: warn or block a send; only host-installed built-ins may rewrite it.
 * - `network`: declaration only. No executor routes a network request yet
 *   (phase 32 adds the broker); declaring it grants nothing.
 * - `fs:project-read`: bounded UTF-8 reads inside the approved project root.
 */
export const PERMISSIONS = [
  'draft:read',
  'draft:read:full',
  'submit:observe',
  'draft:write',
  'submit',
  'network',
  'fs:project-read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Wall-clock budgets per hook call, before scaling by measured scheduler lag
 * (1 to `LIMITS.budgetScaleMax` times). A wall-clock deadline is scheduler
 * dependent, not an OS real-time guarantee.
 */
export const DEADLINES = {
  /** `activate`. */
  activateMs: 50,
  /** `onChange`. */
  changeMs: 100,
  /** `onKey`, after the synchronous claim decision. */
  keyDispatchMs: 10,
  /** All `onBeforeSubmit` calls of one send attempt together. */
  submitTotalMs: 50,
  /** Every other hook: menu selection, actions, committed and project-change events. */
  eventMs: 50,
} as const;

export const LIMITS = {
  /** Plugin entry source (`.mjs`). */
  sourceBytes: 1_048_576,
  /** Serialized result of one isolated hook call. */
  responseBytes: 65_536,
  /** Effects returned by one hook call; more disables the call's output. */
  effectsPerCall: 128,
  /** Applied edits per rolling second per third-party plugin. */
  editsPerSecond: 20,
  /** Default guest memory ceiling; more needs reviewed admission. */
  defaultMemoryMiB: 8,
  /** Largest `resources.memoryMiB` a manifest may request (admission is separate). */
  maxMemoryMiB: 128,
  /** All binary assets of one plugin. */
  assetBytes: 4_194_304,
  /** `murmo.plugin.json`, UTF-8. */
  manifestBytes: 65_536,
  /** Serialized UTF-8 JSON of one plugin's storage namespace. */
  storageBytes: 65_536,
  /** Keys in one storage namespace. */
  storageKeys: 64,
  /** UTF-16 units in one storage key. */
  storageKeyUnits: 128,
  /** Consecutive typed budget faults in one hook that disable a plugin. */
  faultStrikes: 3,
  /** Largest scheduler-lag multiplier applied to `DEADLINES`. */
  budgetScaleMax: 8,
  /** One project file read. */
  projectFileBytes: 262_144,
  /** All project reads of one plugin per session. */
  projectSessionBytes: 1_048_576,
  /** Project read attempts of one plugin per session. */
  projectReads: 128,
} as const;

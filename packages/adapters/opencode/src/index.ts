// @murmo/adapter-opencode: stock OpenCode V2 TUI plugin (docs/plan/22).

export { OpenCodeAdapter, type OpenCodeAdapterOptions } from './adapter.ts';
export { capabilitiesFromProbes, DEGRADED_NOTICE, degradedNotice } from './capabilities.ts';
export { clone } from './clone.ts';
export { opencodeEventDoctor } from './events.ts';
export { bindingMatches, canonicalKey, extraUndoKeys, isPrintableTyped, PROBE_KEYS } from './keys.ts';
export { fromCells, representable, toCells, toHighlightRange } from './offsets.ts';
export { Overlay } from './overlay.ts';
export { hasOpaqueParts, rangeTouchesPart, virtualMarks } from './parts.ts';
export { createTuiPlugin, type TuiHandle, type TuiSetupOptions } from './plugin.ts';
export { registerPrioritize } from './prioritize.ts';
export { type ProbeResult, probeCheckpoints, runProbes } from './probes.ts';
export { loadHostSessionConfig, type SessionStartOptions, type StartedSession, startSession } from './session.ts';
export { createStatusSurface, footerRows, type StatusSurface } from './status.ts';
export {
  FOCUSED_EDITOR,
  INLINE_MAX_BYTES,
  MENU_WINDOW,
  MURMO_HIGHLIGHT_REF,
  MURMO_INLINE_HIGHLIGHT_REF,
  type OpenCodeApi,
  type OpenTuiCore,
  type ParsedKey,
  type PasteEvent,
  STATUS_COLUMNS,
  STATUS_MAX_ROWS,
  type TextareaEditor,
} from './types.ts';

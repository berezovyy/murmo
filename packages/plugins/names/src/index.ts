// @murmo/plugin-names: on-request "did you mean" for project names (phase 36).

export {
  createNamesState,
  memoryBackend,
  NAMES_ID,
  NAMES_VERSION,
  type NamesBackend,
  type NamesMetrics,
  type NamesState,
  namesFactory,
  namesFromPacked,
  namesPlugin,
  PROJECT_REF_ID,
  packedBackend,
  STALE_MS,
} from './plugin.ts';
export { defaultNamesKey, type NamesSettings, resolveNamesSettings } from './settings.ts';

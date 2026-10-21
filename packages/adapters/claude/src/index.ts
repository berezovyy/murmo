// @murmo/adapter-claude: Claude Code plugin that runs the core in Claude's
// plugin runtime (docs/plan/24).

export { ClaudeAdapter, type ClaudeAdapterOptions } from './adapter.ts';
export { claudeCaps, disableInline } from './caps.ts';
export { decodeBase64 } from './decode.ts';
export { type HelperHandle, isolatedFrom, spawnHelper } from './helper.ts';
export { canonicalKey, observedKeys } from './keys.ts';
export {
  configHome,
  dataHome,
  helperPath,
  type LocatedPayload,
  loadTable,
  locatePayload,
  type PayloadTable,
  parseUserConfig,
  readUserConfig,
  TABLE_ASSET,
} from './payload.ts';
export { debugHost, register, resetHost } from './register.ts';
export { type ClaudeHost, type ClaudeSessionOptions, createClaudeHost } from './session.ts';
export {
  CLASSIC_GUARD_TIMEOUT_MS,
  type ClaudeRegister,
  type ClaudeRuntime,
  EDIT_BUDGET_MS,
  INLINE_DISABLED_NOTICE,
  INLINE_MAX_BYTES,
  PLUGIN_VERSION,
  type ProbeFlags,
  TESTED_HOST,
} from './types.ts';

// `@murmo/api`: the plugin author surface. Adapter and executor code imports
// `@murmo/api/adapter`, which re-exports everything here.
//
// PREVIEW: this API can break before Murmo v1. Each breaking change bumps
// `API_DRAFT` and is listed in docs/CHANGELOG.md.

export type {
  PluginService,
  PluginStorage,
  ProjectAccess,
  ProjectChange,
  ProjectReadResult,
  ProjectReadStatus,
  StorageResult,
} from './brokers.ts';
export { SERVICES } from './brokers.ts';
export type {
  Capabilities,
  CapabilityPath,
  CoexistenceCapabilities,
  EditCapabilities,
  InlineCapabilities,
  InlineCommitReceipt,
  InlineRewrite,
  InputOriginEvidence,
  RuntimeCapabilities,
  SubmitCapabilities,
  UiCapabilities,
} from './caps.ts';
export { CAPABILITY_PATHS } from './caps.ts';
export type {
  Certainty,
  Change,
  Draft,
  DraftDelta,
  Gesture,
  HostName,
  HostState,
  Origin,
  Range,
  SubmitGesture,
} from './draft.ts';
export { MASKED_UNIT } from './draft.ts';
export type {
  ActionResult,
  Edit,
  EditResult,
  Effect,
  EffectType,
  InlineMenuEdit,
  MenuItem,
  ResultCode,
} from './effects.ts';
export type { ActionId, KeyClaim, KeyCondition, KeyId, NamedKey, PluginAction } from './keys.ts';
export { ACTIONS, isCanonicalKey, KEY_CONDITIONS, KEY_MODIFIERS, NAMED_KEYS, SHARED_KEYS } from './keys.ts';
export type { Permission } from './limits.ts';
export { API_DRAFT, API_VERSION, DEADLINES, LIMITS, PERMISSIONS } from './limits.ts';
export type {
  CapabilityRequirement,
  ManifestErrorCode,
  Negotiation,
  PermissionDeclaration,
  PluginManifest,
  SettingsProperty,
  SettingsSchema,
} from './manifest.ts';
export {
  API_FEATURES,
  compareVersions,
  MANIFEST_FILE,
  ManifestError,
  negotiate,
  parseManifest,
  parseVersion,
  resolveSettings,
  satisfies,
  validateManifest,
} from './manifest.ts';
export type {
  Cancellation,
  Clock,
  CommitLevel,
  HookEffects,
  Plugin,
  PluginContext,
  PluginFactory,
  PluginHook,
  SubmitCommitted,
  SubmitDecision,
  SubmitPosition,
  SubmitTransaction,
  SubmitUnresolved,
} from './plugin.ts';

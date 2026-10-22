// @murmo/config: reads `murmo.toml` and the project `.murmo.toml` the same way
// on every JS host (this portable part) and in Rust (rust/), with the Node and
// Bun file system side in `@murmo/config/node`.
export type { Diagnostic, DiagnosticCode, DiagnosticSeverity, Position } from './diagnostics.ts';
export { formatDiagnostic, makeDiagnostic } from './diagnostics.ts';
export { CONFIG_LIMITS, FIELD_NAME } from './limits.ts';
export type { EffectiveConfig, EffectivePlugin, MergeInput } from './merge.ts';
export { mergeConfig } from './merge.ts';
export type { PluginSettingsResult } from './plugins.ts';
export { HOST_OWNED_PLUGIN_KEYS, pluginSettings } from './plugins.ts';
export type { LoadedConfig, ReferenceProblem, ReferenceRead, Shortcut } from './references.ts';
export { dropOneNewline, REFERENCE_PROBLEMS, referencedPaths, resolveShortcuts } from './references.ts';
export type {
  ConfigFile,
  ConfigOrigin,
  ConfigSource,
  FieldDefault,
  JsonValue,
  NamesLspSettings,
  NamesSettings,
  PluginTable,
  ShortcutEntry,
  ShortcutMeta,
} from './schema.ts';
export {
  compareCodePoints,
  expansionProblem,
  ignoredFile,
  NAMES_LANGUAGES,
  parseConfig,
  referencePathProblem,
  shortcutProblem,
} from './schema.ts';
export type { Locator, SourceScan } from './source.ts';
export { codePointLength, normalizeToml, scanSource, utf8Length } from './source.ts';
export { displayText, unsafeText } from './text-policy.ts';
export type { TomlParse, TomlTable } from './toml.ts';
export { parseToml } from './toml.ts';
export type { PinnedFile, SymlinkHop } from './trust.ts';
export { TRUST_MANIFEST_VERSION, trustManifest } from './trust.ts';

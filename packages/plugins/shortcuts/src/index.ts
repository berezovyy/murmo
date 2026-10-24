// @murmo/plugin-shortcuts: compile trusted shortcuts into inline and deferred
// tables, collision warnings, the read-only list, and the `;` menu (phase 16).
// Expansion itself is the core interpreter (phase 07).

export {
  COMMON_IDENTIFIERS,
  type CollisionKind,
  type CollisionLexicon,
  collisionKind,
  collisionNotice,
  defaultLexicon,
  lexiconFromSets,
} from './collisions.ts';
export {
  type CompileDiagnostic,
  type CompiledShortcuts,
  type CompiledTemplate,
  type CompileInput,
  type CompileShortcut,
  compileShortcuts,
  INLINE_MAX_BYTES,
  MAX_INSERT_BYTES,
  type NoticeKind,
  replacementsForSpace,
  SHORTCUTS_ID,
  SHORTCUTS_PRIORITY,
  SHORTCUTS_VERSION,
  type ShortcutNotice,
  type ShortcutSource,
} from './compile.ts';
export {
  defaultsOf,
  FIELD_NAME,
  type FieldOccurrence,
  MAX_FIELDS,
  type ParsedTemplate,
  parseTemplate,
  placeholderOf,
  unfilledCount,
  unfilledMessage,
} from './fields.ts';
export { listShortcuts, type ShortcutListItem } from './list.ts';
export { r9MenuShortcuts, SAMPLE_SHORTCUTS, syntheticShortcut } from './menu/catalog.ts';
export {
  compactName,
  displayName,
  filterNames,
  MENU_ROWS,
  type NameTable,
  type PackedEntry,
  packNames,
  type RankedRow,
  rankTemplates,
  TEMPLATE_ROWS,
  tableHasTemplates,
} from './menu/pack.ts';
export {
  createMenuState,
  HISTORY_ID,
  MENU_ID,
  MENU_VERSION,
  type MenuOptions,
  type MenuState,
  menuFactory,
  menuPlugin,
} from './menu/plugin.ts';
export { defaultCellMeasure, formatRow } from './menu/rows.ts';
export { commandPrefix, findTrigger, hostBlocksMenu, inCode, type Trigger } from './menu/trigger.ts';
export { type ConfigShortcuts, compileConfigShortcuts, shortcutRecords } from './records.ts';
export { type InlineCapOptions, shortcutsFactory, shortcutsInlineRules, shortcutsPlugin } from './rules.ts';
export {
  DEFAULT_PREVIOUS_FIELD,
  fieldClaims,
  offerShortcut,
  remapFields,
  remapRange,
} from './session.ts';
export { INIT_TEMPLATE } from './template.ts';

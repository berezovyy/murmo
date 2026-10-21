// @murmo/plugin-shortcuts: compile trusted shortcuts into inline and deferred
// tables, collision warnings, and the read-only list the `;` menu (phase 16)
// will query. Expansion itself is the core interpreter (phase 07).

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
export { listShortcuts, type ShortcutListItem } from './list.ts';
export { type InlineCapOptions, shortcutsFactory, shortcutsInlineRules, shortcutsPlugin } from './rules.ts';
export { INIT_TEMPLATE } from './template.ts';

// @murmo/vocab: project-name protection for autocorrect (docs/plan/19).
// Portable: key function, splitter, extractors, packed protection table.
// The builder, one-fd loader and CLI live in `@murmo/vocab/node`.

export {
  basenameStem,
  CSPELL_NAMES,
  EXCLUSION_VERSION,
  isCspellPath,
  isManifestPath,
  isSourcePath,
  MANIFEST_NAMES,
  pathAllowed,
  SOURCE_EXT,
} from './exclusions.ts';
export {
  identifiersIn,
  isGenerated,
  parseCspell,
  termsFromCargoToml,
  termsFromCspellWords,
  termsFromFile,
  termsFromGoMod,
  termsFromMakefile,
  termsFromPackageJson,
  termsFromPyproject,
  termsFromWordList,
} from './extract-text.ts';
export {
  EXTRACTOR_VERSION,
  IDLE_CHECK_MS,
  LIMITS_VERSION,
  MAX_FILE_BYTES,
  MAX_PROTECT_BYTES,
  MAX_READ_BYTES,
  MAX_TRACKED_FILES,
} from './limits.ts';
export {
  bareName,
  editDistance,
  formatNameRow,
  isCodeLike,
  MAX_QUERY_UNITS,
  MENU_ROWS,
  NATIVE_BUDGET_US,
  NATIVE_CANDIDATES,
  type NameCandidate,
  type NameLocation,
  type RankedName,
  type RankOptions,
  rankNames,
  TOTAL_BUDGET_MS,
  wordKey,
} from './match.ts';
export { MAX_KEY_LENGTH, MIN_KEY_LENGTH, NORMALIZE_VERSION, normalizeKey } from './normalize.ts';
export {
  type BuildRecord,
  bloomCreate,
  bloomHas,
  bloomHashes,
  buildPacked,
  candidatesFrom,
  gramCodes,
  INDEXER_VERSION,
  loadPacked,
  NAMES_BIN,
  NAMES_CURRENT,
  NAMES_DIR,
  NAMES_FILES,
  NAMES_HEADER_BYTES,
  NAMES_MAGIC,
  NAMES_META,
  type PackedEntry,
  type PackedIndex,
} from './packed.ts';
export { splitWords } from './split.ts';
export {
  decodeProtection,
  encodeProtection,
  FILE_CACHE_DIR,
  isProtectedKey,
  NAMES_FILE,
  normalizedKeys,
  PROTECT_FILE,
  PROTECT_FORMAT,
  type ProtectionDecode,
  type ProtectionTable,
  protectedWords,
  protectionKeys,
} from './table.ts';

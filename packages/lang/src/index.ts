// @murmo/lang: language packs at runtime (docs/plan/12). The packed table
// format and its reader, the pack manifest and case policy, full validation for
// install, and the cheap session-start open. Portable: no Node, Bun or host
// APIs; file reads, stat and native hashing come from the caller (src/node/
// for Node and Bun).

export { type CasePolicy, CasePolicyError, parseCasePolicy } from './case-policy.ts';
export {
  CASE_POLICY_FORMAT,
  type LanguagePackManifest,
  MAX_TABLE_BYTES,
  ManifestError,
  PACK_KIND,
  type PackFile,
  type PackLicense,
  type PackTableFile,
  PROVENANCE_FORMAT,
  packFiles,
  parseManifest,
  type SourcePin,
} from './manifest.ts';
export {
  type InstallRecord,
  installRecord,
  type LanguagePack,
  type OpenResult,
  openPack,
  PackError,
  type PackProblem,
  RECORD_KIND,
  type SessionFile,
  type SessionFiles,
  type Sha256,
  VALIDATOR,
  type ValidationReceipt,
  validatePack,
} from './pack.ts';
export {
  encodeTable,
  findEntry,
  HEADER_BYTES,
  keyAt,
  lookup,
  MAX_KEY_BYTES,
  MAX_VALUE_BYTES,
  mapTable,
  type PackedTable,
  TABLE_FORMAT,
  TABLE_MAGIC,
  type TableCheck,
  TableError,
  type TableErrorCode,
  validateTable,
  valueAt,
} from './table.ts';
export { decodeUtf8 } from './utf8.ts';

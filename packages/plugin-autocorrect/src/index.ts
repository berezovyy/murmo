// @murmo/plugin-autocorrect: built-in English autocorrect. Typo work is data
// (InlineRules + english-word-boundary-v1); this package has no onChange path.

export { LEARN_ALLOWLIST, LEARN_DRAFTS, LEARN_WINDOW_MS, noteLearnedRejection, type RejectionRecord } from './learn.ts';
export { type LookupContext, type LookupInput, type LookupOutput, lookupWord } from './lookup.ts';
export {
  type AbstainReason,
  type AutocorrectMetrics,
  emptyMetrics,
  formatDoctorMetrics,
} from './metrics.ts';
export {
  AUTOCORRECT_MANIFEST,
  autocorrectFactory,
  autocorrectSpec,
  createAutocorrectPlugin,
  default,
  doctorLine,
} from './plugin.ts';
export {
  createEnglishPolicy,
  DEFAULT_LOWERCASE_ONLY,
  type EnglishPolicyOptions,
  englishPolicy,
  inCode,
} from './policy.ts';
export {
  AUTOCORRECT_PRIORITY,
  AUTOCORRECT_RULE_ID,
  type EnglishInlineBundle,
  type EnglishRulesOptions,
  englishInlineRules,
  installEnglishPolicy,
  installTestPolicy,
  TABLE_ASSET,
} from './rules.ts';
export {
  type AutocorrectSettings,
  correctionEnabled,
  resolveAutocorrectSettings,
} from './settings.ts';
export { type DisabledKind, disabledReason, STATUS, showsStatus } from './status.ts';
export { type EnglishPackAsset, englishPackAsset, provideEnglishPack } from './table-source.ts';
export { editRangeIsSafe, hasForeignLetters, leadingDecorations, trailingDecorations } from './unicode.ts';

// Plugin settings: opt-in, explicit language, user allowlist. A project file
// can only do less (phase 14 already drops `enabled = true` from `.murmo.toml`).

export interface AutocorrectSettings {
  /** Default false: opt-in until phase 30. */
  readonly enabled: boolean;
  /** Only `en` is shipped; any other tag turns correction off. */
  readonly language: string;
  /** Words that must never be corrected (user allowlist). */
  readonly allow: readonly string[];
}

const ALLOW_SPLIT = /[\s,]+/;

function allowList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((word): word is string => typeof word === 'string' && word.length > 0);
  }
  if (typeof value !== 'string' || value.length === 0) return [];
  return value.split(ALLOW_SPLIT).filter((word) => word.length > 0);
}

export function resolveAutocorrectSettings(input: Readonly<Record<string, unknown>> = {}): AutocorrectSettings {
  const language = typeof input.language === 'string' && input.language.length > 0 ? input.language : 'en';
  return {
    enabled: input.enabled === true,
    language,
    allow: allowList(input.allow),
  };
}

export function correctionEnabled(settings: AutocorrectSettings): boolean {
  return settings.enabled && settings.language === 'en';
}

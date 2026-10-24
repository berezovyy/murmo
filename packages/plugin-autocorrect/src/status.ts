// Why autocorrect is off: a status row on every host with a status surface,
// and the same strings in `murmo doctor` (phase 27). Off by choice (`off`, the
// opt-in default or a project file) is no row: the session's first line says
// "autocorrect off" until the first send. The first-fix notice is the core's
// (`firstFixNotice`), which knows the host's restore keys.

import type { AutocorrectSettings } from './settings.ts';

export const STATUS = {
  off: 'Autocorrect is off. Set [autocorrect] enabled = true in murmo.toml to opt in.',
  language: (tag: string) => `Autocorrect is off: language is ${tag}, not en.`,
  origin: 'Autocorrect is off: this host does not label typed input.',
  capability: 'Autocorrect is off: this host cannot apply inline corrections.',
  table: 'Autocorrect is off: the English table failed to load.',
} as const;

export type DisabledKind = 'off' | 'language' | 'origin' | 'capability' | 'table';

/** Off because something is wrong, not because the user left it off: worth a status row. */
export function showsStatus(kind: DisabledKind): boolean {
  return kind !== 'off';
}

export function disabledReason(
  settings: AutocorrectSettings,
  host: {
    readonly inputOriginEvidence?: string;
    readonly inlineRewrite?: string;
    readonly commitReceipt?: string;
  },
  tableOk: boolean,
): { readonly kind: DisabledKind; readonly text: string } | undefined {
  if (!tableOk) return { kind: 'table', text: STATUS.table };
  if (!settings.enabled) return { kind: 'off', text: STATUS.off };
  if (settings.language !== 'en') return { kind: 'language', text: STATUS.language(settings.language) };
  if (host.inputOriginEvidence !== 'host-labeled') return { kind: 'origin', text: STATUS.origin };
  if (host.inlineRewrite === 'unsupported' || host.commitReceipt === 'none') {
    return { kind: 'capability', text: STATUS.capability };
  }
  return undefined;
}

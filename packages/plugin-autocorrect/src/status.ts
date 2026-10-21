// Status copy: first fix, disabled reason, bad table, missing host origin.
// Shown only where `ui.dialogSafe`; otherwise `murmo doctor` prints the same
// strings (phase 27).

import type { AutocorrectSettings } from './settings.ts';

export const FIRST_FIX_STATUS = 'Autocorrect: Backspace or Undo restores the typed word.';

export const STATUS = {
  off: 'Autocorrect is off. Set [autocorrect] enabled = true in murmo.toml to opt in.',
  language: (tag: string) => `Autocorrect is off: language is ${tag}, not en.`,
  origin: 'Autocorrect is off: this host does not label typed input.',
  capability: 'Autocorrect is off: this host cannot apply inline corrections.',
  table: 'Autocorrect is off: the English table failed to load.',
  firstFix: FIRST_FIX_STATUS,
} as const;

export type DisabledKind = 'off' | 'language' | 'origin' | 'capability' | 'table';

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

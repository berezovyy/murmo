import type { HostCapabilities } from '@murmo/api/adapter';
import { coexistenceFor } from '@murmo/core';
import { observedKeys } from './keys.ts';
import { INLINE_MAX_BYTES } from './types.ts';

/**
 * The prompt hint row when Claude names no width (`viewport` is absent before
 * a surface has measured). The core fills up to the whole row; the adapter
 * keeps the whole rows that fit after Claude's own parts of the row.
 */
export const HINT_ROW_COLUMNS = 120;

/**
 * What Claude draws on the hint row besides `hint` and Murmo's tail, which
 * PromptHint's props don't carry (2.1.302-2.1.306, 120 columns):
 * `  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents · <tail>     ◐ medium · /effort`.
 * The indent; the mode label, drawn only before the mode-cycle hint (`⏵⏵ accept
 * edits on `, `⏸ plan mode on `); the ` · ` before the tail; the effort pill at
 * the right end with its gap. Claude cuts the tail where the pill starts.
 */
export const HINT_INDENT_COLUMNS = 2;
export const MODE_LABEL_COLUMNS = 20;
export const MODE_CYCLE_HINT = '(shift+tab to cycle)';
export const RIGHT_PILL_COLUMNS = 20;

/** Caps before probes. Honest about Claude's measured limits (lessons 36, 47, 64). */
export function claudeCaps(): HostCapabilities {
  return {
    inputOriginEvidence: 'host-labeled',
    semanticMenuSelection: false,
    actions: [],
    inlineRewrite: 'same-transaction',
    inline: {
      attributed: false,
      middle: true,
      multiline: true,
      observedKeys: observedKeys(),
      allKeysObserved: false,
      nativeCompletion: true,
      commitReceipt: 'read-back',
      maxBytes: INLINE_MAX_BYTES,
    },
    readDraft: true,
    edit: {
      atomic: false,
      end: true,
      middle: false,
      multiline: true,
      selection: false,
      exactRestore: false,
      certainties: ['authoritative'],
      attributed: false,
    },
    ghost: 'end-only',
    menu: true,
    highlight: 'none',
    status: true,
    keys: observedKeys(),
    undoKeys: [],
    keyPriority: 'unknown',
    submit: {
      transform: true,
      block: true,
      gestures: ['send', 'queue'],
      guardPosition: 'managed',
      committed: 'none',
    },
    ui: {
      dialogSafe: false,
      anchor: 'host-owned',
      statusMaxLength: HINT_ROW_COLUMNS,
      normalization: 'NFC',
      opaqueParts: false,
      review: true,
      highlightDiagnostics: true,
    },
    coexistence: coexistenceFor('claude'),
  };
}

export function disableInline(caps: HostCapabilities): HostCapabilities {
  return {
    ...caps,
    inlineRewrite: 'unsupported',
    inline: { ...caps.inline, nativeCompletion: false, commitReceipt: 'none' },
    ghost: 'none',
    menu: false,
  };
}

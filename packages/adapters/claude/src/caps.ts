import type { HostCapabilities } from '@murmo/api/adapter';
import { coexistenceFor } from '@murmo/core';
import { observedKeys } from './keys.ts';
import { INLINE_MAX_BYTES } from './types.ts';

/**
 * The prompt hint row as the adapter budgets it. Claude gives plugins no
 * terminal width; at 120 columns its hint and Murmo's tail share one row, and
 * Claude cuts whatever is past the edge. The core fills up to the whole row;
 * the adapter keeps the whole rows that fit after Claude's own hint.
 */
export const HINT_ROW_COLUMNS = 120;

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

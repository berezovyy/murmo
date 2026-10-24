// HostCapabilities from probe results. Never guessed from a version string
// (r12 H3). `ui.dialogSafe` stays false: approval state is unobservable (E9).

import { isCanonicalKey, type KeyId, NAMED_KEYS } from '@murmo/api';
import type { HostCapabilities } from '@murmo/api/adapter';
import { coexistenceFor } from '@murmo/core';
import { extraUndoKeys } from './keys.ts';
import type { ProbeResult } from './probes.ts';
import { INLINE_MAX_BYTES, type OpenCodeApi } from './types.ts';

function printableKeys(): KeyId[] {
  return Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).filter(isCanonicalKey);
}

// Says what the user loses and what to do; the probe, not a version, decides.
export const DEGRADED_NOTICE = 'Shortcuts and autocorrect are off: this OpenCode lacks measureText. Update OpenCode.';

export function capabilitiesFromProbes(
  probe: ProbeResult,
  api: OpenCodeApi,
  options: { readonly submitEnter: boolean } = { submitEnter: true },
): HostCapabilities {
  const measure = probe.measureText;
  const edit = probe.edit && measure;
  const keys: KeyId[] = [
    ...NAMED_KEYS.filter((key) => probe.keys.includes(key) || key === 'space' || key === 'F6'),
    ...printableKeys(),
    'Undo',
    'Newline',
    'Shift+Tab',
    'Ctrl+-',
  ].filter(
    (key, index, all) => all.indexOf(key) === index && (isCanonicalKey(key) || key === 'Undo' || key === 'Newline'),
  );

  const undoKeys: KeyId[] = ['Undo', ...extraUndoKeys(api.keymap)];
  const send = options.submitEnter && probe.keys.includes('Enter');

  return {
    inputOriginEvidence: 'host-labeled',
    semanticMenuSelection: false,
    actions: ['murmo.undo'],
    inlineRewrite: edit ? 'same-transaction' : 'unsupported',
    inline: {
      attributed: true,
      middle: probe.middle && measure,
      multiline: probe.multiline && measure,
      observedKeys: keys,
      allKeysObserved: true,
      nativeCompletion: false,
      commitReceipt: 'native-commit',
      maxBytes: INLINE_MAX_BYTES,
    },
    readDraft: probe.readDraft,
    edit: {
      atomic: edit,
      end: edit,
      middle: probe.middle && measure,
      multiline: probe.multiline && measure,
      selection: probe.selection && measure,
      cursor: edit,
      exactRestore: edit && probe.selection,
      certainties: ['authoritative'],
      attributed: true,
    },
    ghost: probe.ghost ? 'any' : 'none',
    menu: probe.menu,
    highlight: probe.highlight && measure ? 'any' : 'none',
    status: probe.status,
    keys,
    undoKeys,
    keyPriority: 'unknown',
    submit: {
      transform: send && measure,
      block: send,
      gestures: ['send', 'queue', 'newline'],
      guardPosition: 'managed',
      committed: 'accepted-text',
    },
    ui: {
      dialogSafe: false,
      anchor: 'host-owned',
      statusMaxLength: 512,
      normalization: probe.normalization ? 'preserve' : 'unknown',
      opaqueParts: probe.opaqueParts,
      namespace: 'murmo',
      review: true,
      highlightDiagnostics: true,
    },
    coexistence: coexistenceFor('opencode'),
  };
}

export function degradedNotice(probe: ProbeResult): string | null {
  if (probe.measureText) return null;
  return DEGRADED_NOTICE;
}

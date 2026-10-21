// Advertised HostCapabilities. Menu and ghost stay off until prompt detection
// is hardened (phase 23 hand-off). inline.maxBytes is 800 (800-scalar cap).

import type { KeyId } from '@murmo/api';
import { isCanonicalKey, NAMED_KEYS } from '@murmo/api';
import type { HostCapabilities } from '@murmo/api/adapter';

function printable(): KeyId[] {
  return Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).filter(isCanonicalKey);
}

export const INLINE_MAX_BYTES = 800;

export function codexCaps(options: { readonly menu?: boolean; readonly ghost?: boolean } = {}): HostCapabilities {
  const menu = options.menu === true;
  const ghost = options.ghost === true;
  const observed: KeyId[] = ['space', 'Backspace', 'F6', 'Enter', 'Newline', ...printable()];
  return {
    inputOriginEvidence: 'host-labeled',
    semanticMenuSelection: false,
    actions: ['murmo.undo'],
    inlineRewrite: 'immediate-managed-transport',
    inline: {
      attributed: false,
      middle: true,
      multiline: true,
      observedKeys: observed,
      allKeysObserved: true,
      nativeCompletion: false,
      commitReceipt: 'transport-write',
      maxBytes: INLINE_MAX_BYTES,
    },
    readDraft: true,
    edit: {
      atomic: true,
      end: true,
      middle: true,
      multiline: true,
      selection: false,
      exactRestore: true,
      certainties: ['tracked'],
      attributed: false,
    },
    ghost: ghost ? 'end-only' : 'none',
    menu,
    highlight: 'none',
    status: true,
    keys: [...NAMED_KEYS, ...printable()],
    undoKeys: ['F6'],
    keyPriority: 'before-peers',
    submit: {
      transform: true,
      block: true,
      gestures: ['send', 'queue', 'newline'],
      guardPosition: 'managed',
      committed: 'none',
    },
    ui: {
      dialogSafe: false,
      anchor: 'overlay',
      statusMaxLength: 99,
      normalization: 'preserve',
      opaqueParts: true,
    },
  };
}

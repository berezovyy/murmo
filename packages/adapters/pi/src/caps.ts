import { isCanonicalKey, type KeyId } from '@murmo/api';
import type { HostCapabilities } from '@murmo/api/adapter';
import { INLINE_MAX_BYTES } from './types.ts';

const PRINTABLE: readonly KeyId[] = Array.from({ length: 95 }, (_, i) => {
  const ch = String.fromCharCode(32 + i);
  return ch === ' ' ? 'space' : ch;
}).filter((id) => id === 'space' || isCanonicalKey(id));

export const OBSERVED_KEYS: readonly KeyId[] = [
  'Tab',
  'Enter',
  'Escape',
  'Up',
  'Down',
  'Left',
  'Right',
  'Backspace',
  'F6',
  'Undo',
  ...PRINTABLE,
];

export function offCaps(): HostCapabilities {
  return {
    inputOriginEvidence: 'unknown',
    semanticMenuSelection: false,
    actions: [],
    inlineRewrite: 'unsupported',
    inline: {
      attributed: false,
      middle: false,
      multiline: false,
      observedKeys: [],
      allKeysObserved: false,
      nativeCompletion: false,
      commitReceipt: 'none',
      maxBytes: INLINE_MAX_BYTES,
    },
    readDraft: false,
    edit: {
      atomic: false,
      end: false,
      middle: false,
      multiline: false,
      selection: false,
      exactRestore: false,
      certainties: [],
      attributed: false,
    },
    ghost: 'none',
    menu: false,
    highlight: 'none',
    status: false,
    keys: [],
    undoKeys: [],
    keyPriority: 'unknown',
    submit: {
      transform: false,
      block: false,
      gestures: [],
      guardPosition: 'managed',
      committed: 'none',
    },
    ui: {
      dialogSafe: false,
      anchor: 'host-owned',
      statusMaxLength: 512,
      normalization: 'preserve',
      opaqueParts: true,
      review: false,
      highlightDiagnostics: false,
    },
    coexistence: {
      editorComposition: 'exclusive',
      keyArbitration: 'unknown',
      peerUiObservable: false,
    },
  };
}

export function piCaps(
  patch: Partial<HostCapabilities> & {
    inline?: Partial<HostCapabilities['inline']>;
    edit?: Partial<HostCapabilities['edit']>;
    submit?: Partial<HostCapabilities['submit']>;
    ui?: Partial<HostCapabilities['ui']>;
  },
): HostCapabilities {
  const base = offCaps();
  const coexistence = patch.coexistence ?? base.coexistence;
  return {
    ...base,
    ...patch,
    inline: { ...base.inline, ...patch.inline },
    edit: { ...base.edit, ...patch.edit },
    submit: { ...base.submit, ...patch.submit },
    ui: { ...base.ui, ...patch.ui },
    ...(coexistence ? { coexistence } : {}),
  };
}

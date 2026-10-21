// In-memory drafts backend: the conformance guest has no file system, and
// unit tests that don't care about 0600 use this. Same offer/lock/expiry
// rules as the file backend.

import {
  checkDraftIdentity,
  type DraftDocument,
  type DraftIdentity,
  type DraftSaveResult,
  type Drafts,
  type DraftWrite,
  decodeDraft,
  draftExpired,
  draftHeader,
  draftIsOfferable,
  encodeDraft,
} from './draft.ts';
import { utf8Length } from './encoding.ts';
import { checkDraftHost, checkProjectId, type DraftHost } from './layout.ts';

export interface MemoryDraftsOptions {
  readonly isPrivate?: () => boolean | Promise<boolean>;
  readonly now?: () => number;
}

interface Slot {
  bytes: Uint8Array;
  lock?: { readonly token: string };
}

function keyOf(id: DraftIdentity): string {
  const i = checkDraftIdentity(id);
  return `${i.project}/${i.host}/${i.session}`;
}

function parseKey(key: string): DraftIdentity | undefined {
  const parts = key.split('/');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return undefined;
  try {
    return checkDraftIdentity({ project: parts[0], host: parts[1] as DraftHost, session: parts[2] });
  } catch {
    return undefined;
  }
}

let lockSeq = 0;

function encodeOf(id: DraftIdentity, write: DraftWrite, now: number): Uint8Array {
  const identity = checkDraftIdentity(id);
  const header = draftHeader(identity, {
    revision: write.revision,
    cursorUTF16: write.cursorUTF16,
    capturedAt: now,
    textBytes: utf8Length(write.text),
    ...(write.attempted === true ? { attempted: true } : {}),
  });
  return encodeDraft(header, write.text);
}

export function createMemoryDrafts(options: MemoryDraftsOptions = {}): Drafts {
  const slots = new Map<string, Slot>();
  const held = new Map<string, string>();
  const nowOf = options.now ?? (() => Date.now());
  const privateOf = options.isPrivate ?? (() => false);

  const readSlot = (key: string): DraftDocument | undefined => {
    const slot = slots.get(key);
    if (!slot || slot.bytes.length === 0) return undefined;
    const decoded = decodeDraft(slot.bytes);
    return decoded.ok ? decoded.document : undefined;
  };

  const live = (key: string): boolean => {
    const slot = slots.get(key);
    const token = slot?.lock?.token;
    return token !== undefined && held.get(key) === token;
  };

  const save = async (id: DraftIdentity, write: DraftWrite): Promise<DraftSaveResult> => {
    if (await privateOf()) {
      slots.delete(keyOf(id));
      return { status: 'denied', reason: 'private mode' };
    }
    if (write.text.length === 0) return { status: 'denied', reason: 'empty' };
    const now = write.now ?? nowOf();
    const identity = checkDraftIdentity(id);
    try {
      const bytes = encodeOf(identity, write, now);
      const key = keyOf(identity);
      const previous = slots.get(key);
      slots.set(key, { bytes, ...(previous?.lock ? { lock: previous.lock } : {}) });
      for (const [other] of [...slots]) {
        const oid = parseKey(other);
        if (!oid || oid.project !== identity.project || oid.host !== identity.host) continue;
        if (oid.session === identity.session) continue;
        if (live(other)) continue;
        slots.delete(other);
        held.delete(other);
      }
      return { status: 'ok' };
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes('64 KiB') || message.includes('textBytes')) {
        slots.delete(keyOf(id));
        return { status: 'denied', reason: 'oversize' };
      }
      return { status: 'error', reason: message };
    }
  };

  return {
    save,
    async read(id) {
      return readSlot(keyOf(id));
    },
    async delete(id) {
      slots.delete(keyOf(id));
    },
    async markAttempted(id, now) {
      const key = keyOf(id);
      const document = readSlot(key);
      if (!document) return;
      const bytes = encodeOf(
        checkDraftIdentity(id),
        {
          text: document.text,
          cursorUTF16: document.header.cursorUTF16,
          revision: document.header.revision,
          now: now ?? document.header.capturedAt,
          attempted: true,
        },
        now ?? document.header.capturedAt,
      );
      const previous = slots.get(key);
      slots.set(key, { bytes, ...(previous?.lock ? { lock: previous.lock } : {}) });
    },
    async holdLock(id) {
      const key = keyOf(id);
      const token = `m${++lockSeq}`;
      const slot = slots.get(key) ?? { bytes: new Uint8Array() };
      slot.lock = { token };
      slots.set(key, slot);
      held.set(key, token);
      return {
        async release() {
          if (held.get(key) !== token) return;
          held.delete(key);
          const current = slots.get(key);
          if (!current || current.lock?.token !== token) return;
          if (current.bytes.length === 0) slots.delete(key);
          else slots.set(key, { bytes: current.bytes });
        },
      };
    },
    async findOfferable(query) {
      const project = checkProjectId(query.project);
      const host = checkDraftHost(query.host);
      const now = query.now ?? nowOf();
      let best: DraftDocument | undefined;
      for (const [key] of slots) {
        const id = parseKey(key);
        if (!id || id.project !== project || id.host !== host) continue;
        if (query.session !== undefined && id.session === query.session) continue;
        if (live(key)) continue;
        const document = readSlot(key);
        if (!document || !draftIsOfferable(document, now)) continue;
        if (!best || document.header.capturedAt > best.header.capturedAt) best = document;
      }
      return best;
    },
    async cleanup(now) {
      const at = now ?? nowOf();
      let removed = 0;
      for (const [key, slot] of [...slots]) {
        if (slot.bytes.length === 0) continue;
        const decoded = decodeDraft(slot.bytes);
        if (!decoded.ok || draftExpired(decoded.document, at)) {
          slots.delete(key);
          held.delete(key);
          removed++;
        }
      }
      return { removed };
    },
  };
}

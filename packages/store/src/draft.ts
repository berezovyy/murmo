// DRAFT-FORMAT v1: one JSON header line, a newline byte, then raw UTF-8 text
// (experiments/history/DRAFT-FORMAT.md). Portable: no IO. The Node backend
// (./node/drafts.ts) writes these bytes; a memory backend is for tests and
// the conformance guest, which has no file system.

import { utf8Decode, utf8Encode, utf8Length } from './encoding.ts';
import { checkDraftHost, checkProjectId, checkSessionId, type DraftHost } from './layout.ts';

/** Maximum UTF-8 bytes of draft text. The envelope may add at most 1 KiB. */
export const DRAFT_MAX_TEXT_BYTES = 65_536;
/** JSON header line, including the trailing newline. */
export const DRAFT_MAX_HEADER_BYTES = 1024;
/** 24 hours from capture. */
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export interface DraftIdentity {
  readonly project: string;
  readonly host: DraftHost;
  readonly session: string;
}

export interface DraftHeader {
  readonly version: 1;
  readonly project: string;
  readonly host: DraftHost;
  readonly session: string;
  readonly revision: number;
  readonly cursorUTF16: number;
  readonly capturedAt: number;
  readonly expiresAt: number;
  readonly textBytes: number;
  /**
   * Set at commit level `unknown`: the attempt passed the guards but the core
   * could not tell whether it was sent. Never offered; replaced by the next
   * save of a changed draft, otherwise expires.
   */
  readonly attempted?: boolean;
}

export interface DraftDocument {
  readonly header: DraftHeader;
  readonly text: string;
}

export type DraftDecode =
  | { readonly ok: true; readonly document: DraftDocument }
  | { readonly ok: false; readonly reason: string };

function isUtf16Boundary(text: string, at: number): boolean {
  if (at < 0 || at > text.length || !Number.isInteger(at)) return false;
  if (at === 0 || at === text.length) return true;
  const prev = text.charCodeAt(at - 1);
  const cur = text.charCodeAt(at);
  return !(prev >= 0xd800 && prev <= 0xdbff && cur >= 0xdc00 && cur <= 0xdfff);
}

export function checkDraftIdentity(id: DraftIdentity): DraftIdentity {
  return { project: checkProjectId(id.project), host: checkDraftHost(id.host), session: checkSessionId(id.session) };
}

export function draftHeader(
  id: DraftIdentity,
  fields: {
    readonly revision: number;
    readonly cursorUTF16: number;
    readonly capturedAt: number;
    readonly textBytes: number;
    readonly attempted?: boolean;
  },
): DraftHeader {
  const identity = checkDraftIdentity(id);
  if (!Number.isInteger(fields.revision) || fields.revision < 0)
    throw new Error('draft revision must be a whole number');
  if (!Number.isFinite(fields.capturedAt)) throw new Error('draft capturedAt must be a finite time');
  if (!Number.isInteger(fields.textBytes) || fields.textBytes < 0 || fields.textBytes > DRAFT_MAX_TEXT_BYTES) {
    throw new Error('draft textBytes is out of range');
  }
  const header: DraftHeader = {
    version: 1,
    project: identity.project,
    host: identity.host,
    session: identity.session,
    revision: fields.revision,
    cursorUTF16: fields.cursorUTF16,
    capturedAt: fields.capturedAt,
    expiresAt: fields.capturedAt + DRAFT_TTL_MS,
    textBytes: fields.textBytes,
    ...(fields.attempted === true ? { attempted: true } : {}),
  };
  return header;
}

/** Encodes a complete document. Refuses an oversize header or text, or a cursor inside a character. */
export function encodeDraft(header: DraftHeader, text: string): Uint8Array {
  if (typeof text !== 'string') throw new Error('draft text must be a string');
  const textBytes = utf8Length(text);
  if (textBytes > DRAFT_MAX_TEXT_BYTES) throw new Error('draft text is larger than 64 KiB');
  if (header.textBytes !== textBytes) throw new Error('draft textBytes does not match the text');
  if (!isUtf16Boundary(text, header.cursorUTF16)) throw new Error('draft cursor is not a UTF-16 character boundary');
  const line = `${JSON.stringify(header)}\n`;
  const head = utf8Encode(line);
  if (head.length > DRAFT_MAX_HEADER_BYTES) throw new Error('draft header is larger than 1 KiB');
  const body = utf8Encode(text);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

function asHeader(value: unknown): DraftHeader | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return undefined;
  if (typeof v.project !== 'string' || typeof v.host !== 'string' || typeof v.session !== 'string') return undefined;
  if (!Number.isInteger(v.revision) || (v.revision as number) < 0) return undefined;
  if (!Number.isInteger(v.cursorUTF16)) return undefined;
  if (!Number.isFinite(v.capturedAt) || !Number.isFinite(v.expiresAt)) return undefined;
  if (!Number.isInteger(v.textBytes) || (v.textBytes as number) < 0 || (v.textBytes as number) > DRAFT_MAX_TEXT_BYTES) {
    return undefined;
  }
  if (v.attempted !== undefined && v.attempted !== true) return undefined;
  try {
    const identity = checkDraftIdentity({
      project: v.project,
      host: checkDraftHost(v.host),
      session: v.session,
    });
    return {
      version: 1,
      project: identity.project,
      host: identity.host,
      session: identity.session,
      revision: v.revision as number,
      cursorUTF16: v.cursorUTF16 as number,
      capturedAt: v.capturedAt as number,
      expiresAt: v.expiresAt as number,
      textBytes: v.textBytes as number,
      ...(v.attempted === true ? { attempted: true } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Parses bytes into a document. Does not apply expiry; the reader does, so an
 * expired file can be unlinked instead of offered.
 */
export function decodeDraft(bytes: Uint8Array): DraftDecode {
  if (bytes.length > DRAFT_MAX_TEXT_BYTES + DRAFT_MAX_HEADER_BYTES) return { ok: false, reason: 'too large' };
  let boundary = -1;
  const limit = Math.min(bytes.length, DRAFT_MAX_HEADER_BYTES);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0x0a) {
      boundary = i;
      break;
    }
  }
  if (boundary < 0) return { ok: false, reason: 'header' };
  const head = utf8Decode(bytes.subarray(0, boundary));
  if (head === null) return { ok: false, reason: 'header' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(head);
  } catch {
    return { ok: false, reason: 'header' };
  }
  const header = asHeader(parsed);
  if (!header) return { ok: false, reason: 'header' };
  const body = bytes.subarray(boundary + 1);
  if (body.length !== header.textBytes) return { ok: false, reason: 'length' };
  const text = utf8Decode(body);
  if (text === null) return { ok: false, reason: 'text' };
  if (utf8Length(text) !== header.textBytes) return { ok: false, reason: 'length' };
  if (!isUtf16Boundary(text, header.cursorUTF16)) return { ok: false, reason: 'cursor' };
  if (header.expiresAt <= header.capturedAt || header.expiresAt > header.capturedAt + DRAFT_TTL_MS) {
    return { ok: false, reason: 'expiry' };
  }
  return { ok: true, document: { header, text } };
}

/** True when a decoded document may be offered at `now` (identity already matched by the reader). */
export function draftIsOfferable(document: DraftDocument, now: number): boolean {
  if (document.header.attempted === true) return false;
  if (document.header.expiresAt <= now) return false;
  if (document.text.length === 0) return false;
  return true;
}

export function draftExpired(document: DraftDocument, now: number): boolean {
  return document.header.expiresAt <= now;
}

export type DraftSaveResult =
  | { readonly status: 'ok' }
  | { readonly status: 'denied'; readonly reason: string }
  | { readonly status: 'error'; readonly reason: string };

export interface DraftWrite {
  readonly text: string;
  readonly cursorUTF16: number;
  readonly revision: number;
  readonly now?: number;
  readonly attempted?: boolean;
}

export interface HeldDraftLock {
  release(): Promise<void>;
}

/**
 * The drafts kind: built-in rescue only. A memory or file backend; the plugin
 * never talks to the file system itself.
 */
export interface Drafts {
  save(id: DraftIdentity, write: DraftWrite): Promise<DraftSaveResult>;
  read(id: DraftIdentity): Promise<DraftDocument | undefined>;
  delete(id: DraftIdentity): Promise<void>;
  markAttempted(id: DraftIdentity, now?: number): Promise<void>;
  holdLock(id: DraftIdentity): Promise<HeldDraftLock>;
  findOfferable(query: {
    readonly project: string;
    readonly host: DraftHost;
    readonly session?: string;
    readonly now?: number;
  }): Promise<DraftDocument | undefined>;
  cleanup(now?: number): Promise<{ readonly removed: number }>;
}

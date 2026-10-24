// The helper side of the store protocol, on the Node and Bun store. The Rust
// helper (rust/src/protocol.rs) is the one Claude sessions reach in
// production; this handler is its reference, and the protocol test checks
// both give the same replies.
import { isAbsolute } from 'node:path';
import type { DraftDocument, DraftIdentity, HeldDraftLock } from '../draft.ts';
import type { DraftHost } from '../layout.ts';
import { type DraftWireId, parseStoreRequest, type StoreReply } from '../protocol.ts';
import { projectIdOfCwd } from './paths.ts';
import type { Store, WriteResult } from './store.ts';

/** Draft session locks this process holds for its clients, per store, until `drafts.unlock`. */
const heldLocks = new WeakMap<Store, Map<string, HeldDraftLock>>();

function locksOf(store: Store): Map<string, HeldDraftLock> {
  let locks = heldLocks.get(store);
  if (!locks) {
    locks = new Map();
    heldLocks.set(store, locks);
  }
  return locks;
}

/** The store checks the fields; a bad host fails that check like a bad project does. */
const identityOf = (id: DraftWireId): DraftIdentity => ({
  project: id.project,
  host: id.host as DraftHost,
  session: id.session,
});
const lockKey = (id: DraftWireId) => `${id.project}/${id.host}/${id.session}`;
const documentReply = (document: DraftDocument | undefined): StoreReply =>
  document ? { status: 'ok', value: { header: document.header, text: document.text } } : { status: 'ok' };

function fromWrite(result: WriteResult): StoreReply {
  if (result.status === 'ok') return { status: 'ok' };
  return result.status === 'busy' ? { status: 'busy', reason: 'store is busy; try again' } : result;
}

/** A log line must be one JSON object on one line, as `JSON.stringify` of an entry writes it. */
function isEntryLine(line: string): boolean {
  if (line.includes('\n') || line.includes('\r')) return false;
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

/**
 * Answers one request. The session already gated user text (see protocol.ts),
 * so this store's own gate is the identity check: it never refuses here.
 */
export async function handleStoreRequest(store: Store, message: unknown): Promise<StoreReply> {
  const request = parseStoreRequest(message);
  if (!request) return { status: 'error', reason: 'malformed store request' };
  try {
    switch (request.op) {
      case 'storage.get':
        return await store.plugins.forPlugin(request.plugin).get(request.key);
      case 'storage.set':
        if (typeof request.expected === 'number') {
          return await store.plugins.forPlugin(request.plugin).cas(request.key, request.expected, request.value);
        }
        return await store.plugins.forPlugin(request.plugin).set(request.key, request.value);
      case 'storage.delete':
        return await store.plugins.forPlugin(request.plugin).delete(request.key);
      case 'private.get':
        return { status: 'ok', value: await store.privacy.isPrivate() };
      case 'generation.get':
        return { status: 'ok', value: await store.generation() };
      case 'words.add':
        return fromWrite(
          await store.words.add(request.word, {
            learned: request.learned,
            ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
          }),
        );
      case 'log.append': {
        if (!request.lines.every(isEntryLine)) return { status: 'error', reason: 'log lines must be JSON objects' };
        const entries = request.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
        return fromWrite(await store.logs.session(request.kind, request.session).append(entries));
      }
      case 'project.id': {
        if (!isAbsolute(request.cwd)) return { status: 'error', reason: 'cwd must be an absolute path' };
        try {
          return { status: 'ok', value: await projectIdOfCwd(request.cwd) };
        } catch {
          return { status: 'error', reason: 'cannot resolve the project of this directory' };
        }
      }
      case 'drafts.save':
        return await store.drafts.save(identityOf(request.draft), {
          text: request.text,
          cursorUTF16: request.cursorUTF16,
          revision: request.revision,
          ...(request.now === undefined ? {} : { now: request.now }),
          ...(request.attempted === true ? { attempted: true } : {}),
        });
      case 'drafts.read':
        return documentReply(await store.drafts.read(identityOf(request.draft)));
      case 'drafts.delete':
        await store.drafts.delete(identityOf(request.draft));
        return { status: 'ok' };
      case 'drafts.markAttempted':
        await store.drafts.markAttempted(identityOf(request.draft), request.now);
        return { status: 'ok' };
      case 'drafts.lock': {
        const held = await store.drafts.holdLock(identityOf(request.draft));
        locksOf(store).set(lockKey(request.draft), held);
        return { status: 'ok' };
      }
      case 'drafts.unlock': {
        const locks = locksOf(store);
        const held = locks.get(lockKey(request.draft));
        locks.delete(lockKey(request.draft));
        await held?.release();
        return { status: 'ok' };
      }
      case 'drafts.offer':
        return documentReply(
          await store.drafts.findOfferable({
            project: request.project,
            host: request.host as DraftHost,
            ...(request.session === undefined ? {} : { session: request.session }),
            ...(request.now === undefined ? {} : { now: request.now }),
          }),
        );
      case 'drafts.cleanup':
        return { status: 'ok', value: await store.drafts.cleanup(request.now) };
    }
  } catch (error) {
    return { status: 'error', reason: (error as Error).message };
  }
}

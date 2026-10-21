// The helper side of the store protocol, on the Node and Bun store. The Rust
// helper (rust/src/protocol.rs) is the one Claude sessions reach in
// production; this handler is its reference, and the protocol test checks
// both give the same replies.
import { parseStoreRequest, type StoreReply } from '../protocol.ts';
import type { Store, WriteResult } from './store.ts';

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
    }
  } catch (error) {
    return { status: 'error', reason: (error as Error).message };
  }
}

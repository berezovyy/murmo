// The drafts kind through the helper: Claude's plugin runtime can't write a
// 0600 file atomically or list a folder, so the helper owns the draft files
// and the session's liveness lock (protocol.ts `drafts.*`). Portable: the
// transport is the adapter's, looked up per request so a restarted helper is
// used as soon as it is up.
//
// Never rejects: rescue runs these off the key path, and a helper that is
// down means "not saved" and "nothing to offer", not an error in the host.
import {
  checkDraftIdentity,
  type DraftDocument,
  type DraftIdentity,
  type DraftSaveResult,
  type Drafts,
  decodeDraft,
  encodeDraft,
} from './draft.ts';
import { checkDraftHost, checkProjectId } from './layout.ts';
import type { StoreReply, StoreRequest } from './protocol.ts';
import type { StoreTransport } from './remote.ts';

const UNAVAILABLE = 'the Murmo helper is not running';

/** A document from the wire, checked the way a file is: anything malformed is no document. */
function documentOf(value: unknown): DraftDocument | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as { header?: unknown; text?: unknown };
  if (typeof v.text !== 'string' || typeof v.header !== 'object' || v.header === null) return undefined;
  try {
    const decoded = decodeDraft(encodeDraft(v.header as DraftDocument['header'], v.text));
    return decoded.ok ? decoded.document : undefined;
  } catch {
    return undefined;
  }
}

export function createRemoteDrafts(transport: () => StoreTransport | undefined): Drafts {
  const send = async (message: StoreRequest): Promise<StoreReply | undefined> => {
    const current = transport();
    if (!current) return undefined;
    try {
      return await current.request(message);
    } catch {
      return undefined;
    }
  };
  const wire = (id: DraftIdentity) => {
    const i = checkDraftIdentity(id);
    return { project: i.project, host: i.host, session: i.session };
  };

  return {
    async save(id, write): Promise<DraftSaveResult> {
      const reply = await send({
        op: 'drafts.save',
        draft: wire(id),
        text: write.text,
        cursorUTF16: write.cursorUTF16,
        revision: write.revision,
        ...(write.now === undefined ? {} : { now: write.now }),
        ...(write.attempted === true ? { attempted: true } : {}),
      });
      if (!reply) return { status: 'error', reason: UNAVAILABLE };
      if (reply.status === 'ok') return { status: 'ok' };
      const reason = reply.reason ?? reply.status;
      return reply.status === 'denied' ? { status: 'denied', reason } : { status: 'error', reason };
    },
    async read(id) {
      const reply = await send({ op: 'drafts.read', draft: wire(id) });
      return reply?.status === 'ok' ? documentOf(reply.value) : undefined;
    },
    async delete(id) {
      await send({ op: 'drafts.delete', draft: wire(id) });
    },
    async markAttempted(id, now) {
      await send({ op: 'drafts.markAttempted', draft: wire(id), ...(now === undefined ? {} : { now }) });
    },
    async holdLock(id) {
      const wired = wire(id);
      const reply = await send({ op: 'drafts.lock', draft: wired });
      if (reply && reply.status !== 'ok') throw new Error(reply.reason ?? 'could not take the draft session lock');
      return {
        async release() {
          await send({ op: 'drafts.unlock', draft: wired });
        },
      };
    },
    async findOfferable(query) {
      const reply = await send({
        op: 'drafts.offer',
        project: checkProjectId(query.project),
        host: checkDraftHost(query.host),
        ...(query.session === undefined ? {} : { session: query.session }),
        ...(query.now === undefined ? {} : { now: query.now }),
      });
      return reply?.status === 'ok' ? documentOf(reply.value) : undefined;
    },
    async cleanup(now) {
      const reply = await send({ op: 'drafts.cleanup', ...(now === undefined ? {} : { now }) });
      const removed = reply?.status === 'ok' ? (reply.value as { removed?: unknown } | undefined)?.removed : undefined;
      return { removed: typeof removed === 'number' ? removed : 0 };
    },
  };
}

/** The project a session in `cwd` belongs to, from the helper; undefined when it can't say. */
export async function remoteProjectId(transport: StoreTransport, cwd: string): Promise<string | undefined> {
  try {
    const reply = await transport.request({ op: 'project.id', cwd });
    if (reply.status !== 'ok' || typeof reply.value !== 'string') return undefined;
    return checkProjectId(reply.value);
  } catch {
    return undefined;
  }
}

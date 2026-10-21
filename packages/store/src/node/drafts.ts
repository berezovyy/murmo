// File drafts: DRAFT-FORMAT v1 under `$XDG_STATE_HOME/murmo/drafts/v1/`.
// Atomic exclusive temp 0600 + rename (writeAtomic). Session liveness is
// `<sessionId>.lock` (O_EXCL, PID and start token) next to the snapshot; a
// snapshot is offerable only when that owner is dead or the lock is missing.
import { execFileSync } from 'node:child_process';
import { constants, readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  checkDraftIdentity,
  DRAFT_MAX_HEADER_BYTES,
  DRAFT_MAX_TEXT_BYTES,
  type DraftDocument,
  type DraftIdentity,
  type Drafts,
  decodeDraft,
  draftExpired,
  draftHeader,
  draftIsOfferable,
  encodeDraft,
} from '../draft.ts';
import { utf8Length } from '../encoding.ts';
import {
  checkDraftHost,
  checkProjectId,
  checkSessionId,
  type DraftHost,
  draftFile,
  draftLockFile,
  projectDrafts,
  type StoreLayout,
} from '../layout.ts';
import {
  ensurePrivateDir,
  errorCode,
  exists,
  FILE_MODE,
  type ModeRepairs,
  processAlive,
  readStoreFile,
  removeStaleTemps,
  writeAtomic,
} from './files.ts';
import type { Privacy } from './privacy.ts';

const FILE_MAX = DRAFT_MAX_TEXT_BYTES + DRAFT_MAX_HEADER_BYTES;

export interface FileDraftsOptions {
  readonly layout: StoreLayout;
  readonly privacy: Privacy;
  readonly repairs?: ModeRepairs;
}

interface LockBody {
  readonly pid: number;
  readonly start: string;
  readonly acquiredAt: number;
  readonly token: string;
}

function startToken(pid: number): string | undefined {
  if (process.platform === 'linux') {
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = raw.lastIndexOf(')');
      const ticks = raw.slice(close + 2).split(' ')[19];
      return ticks === undefined ? undefined : `l:${ticks}`;
    } catch {
      return undefined;
    }
  }
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return undefined;
    const at = Date.parse(out);
    return Number.isFinite(at) ? `d:${at}` : `d:${out}`;
  } catch {
    return undefined;
  }
}

function lockStale(body: LockBody | undefined): boolean {
  if (!body) return true;
  if (!processAlive(body.pid)) return true;
  const now = startToken(body.pid);
  return now !== undefined && body.start !== '' && now !== body.start;
}

async function readLock(path: string): Promise<LockBody | undefined> {
  try {
    const value = JSON.parse(await fsp.readFile(path, 'utf8')) as Partial<LockBody>;
    if (
      typeof value.pid === 'number' &&
      typeof value.start === 'string' &&
      typeof value.acquiredAt === 'number' &&
      typeof value.token === 'string'
    ) {
      return value as LockBody;
    }
  } catch {
    // missing or not ours
  }
  return undefined;
}

async function writeLock(path: string, body: LockBody): Promise<void> {
  const handle = await fsp.open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    FILE_MODE,
  );
  try {
    await handle.chmod(FILE_MODE);
    await handle.writeFile(`${JSON.stringify(body)}\n`);
  } finally {
    await handle.close();
  }
}

function sessionOfDraftName(name: string): string | undefined {
  if (!name.endsWith('.draft')) return undefined;
  const session = name.slice(0, -'.draft'.length);
  try {
    return checkSessionId(session);
  } catch {
    return undefined;
  }
}

export function createFileDrafts(options: FileDraftsOptions): Drafts {
  const { layout, privacy, repairs } = options;
  const base = layout.roots.state;
  let tokenSeq = 0;
  const held = new Map<string, { token: string; path: string }>();

  const fileOf = (id: DraftIdentity) => {
    const i = checkDraftIdentity(id);
    return draftFile(layout, i.project, i.host, i.session);
  };
  const lockOf = (id: DraftIdentity) => {
    const i = checkDraftIdentity(id);
    return draftLockFile(layout, i.project, i.host, i.session);
  };

  const unlink = async (path: string) => {
    await fsp.rm(path, { force: true });
  };

  const readDocument = async (path: string): Promise<DraftDocument | undefined> => {
    const read = await readStoreFile(path, FILE_MAX, repairs);
    if (read.status !== 'ok') return undefined;
    const decoded = decodeDraft(read.bytes);
    return decoded.ok ? decoded.document : undefined;
  };

  const liveLock = async (lockPath: string): Promise<boolean> => {
    const heldHere = held.get(lockPath);
    if (heldHere) return true;
    if (!(await exists(lockPath))) return false;
    const body = await readLock(lockPath);
    return !lockStale(body);
  };

  const sweepDead = async (id: DraftIdentity): Promise<void> => {
    const dir = dirname(fileOf(id));
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw error;
    }
    for (const name of names) {
      const session = sessionOfDraftName(name);
      if (!session || session === id.session) continue;
      const other = { project: id.project, host: id.host, session };
      if (await liveLock(lockOf(other))) continue;
      await unlink(fileOf(other));
      await unlink(lockOf(other));
    }
  };

  return {
    async save(id, write) {
      if (await privacy.isPrivate()) {
        await unlink(fileOf(id));
        return { status: 'denied', reason: 'private mode' };
      }
      if (write.text.length === 0) return { status: 'denied', reason: 'empty' };
      const now = write.now ?? Date.now();
      const identity = checkDraftIdentity(id);
      const textBytes = utf8Length(write.text);
      if (textBytes > DRAFT_MAX_TEXT_BYTES) {
        await unlink(fileOf(identity));
        return { status: 'denied', reason: 'oversize' };
      }
      try {
        const header = draftHeader(identity, {
          revision: write.revision,
          cursorUTF16: write.cursorUTF16,
          capturedAt: now,
          textBytes,
          ...(write.attempted === true ? { attempted: true } : {}),
        });
        const bytes = encodeDraft(header, write.text);
        const target = fileOf(identity);
        await ensurePrivateDir(dirname(target), base, repairs);
        await writeAtomic(target, bytes);
        await sweepDead(identity);
        return { status: 'ok' };
      } catch (error) {
        return { status: 'error', reason: (error as Error).message };
      }
    },

    async read(id) {
      return readDocument(fileOf(id));
    },

    async delete(id) {
      await unlink(fileOf(id));
    },

    async markAttempted(id, now) {
      const path = fileOf(id);
      const document = await readDocument(path);
      if (!document) return;
      const identity = checkDraftIdentity(id);
      const capturedAt = now ?? document.header.capturedAt;
      const header = draftHeader(identity, {
        revision: document.header.revision,
        cursorUTF16: document.header.cursorUTF16,
        capturedAt,
        textBytes: document.header.textBytes,
        attempted: true,
      });
      await ensurePrivateDir(dirname(path), base, repairs);
      await writeAtomic(path, encodeDraft(header, document.text));
    },

    async holdLock(id) {
      const identity = checkDraftIdentity(id);
      const path = lockOf(identity);
      const existing = held.get(path);
      if (existing) {
        return {
          async release() {
            if (held.get(path)?.token !== existing.token) return;
            held.delete(path);
            await unlink(path);
          },
        };
      }
      await ensurePrivateDir(dirname(path), base, repairs);
      const token = `${process.pid}.${++tokenSeq}.${Date.now()}`;
      const body: LockBody = {
        pid: process.pid,
        start: startToken(process.pid) ?? '',
        acquiredAt: Date.now(),
        token,
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await writeLock(path, body);
          held.set(path, { token, path });
          return {
            async release() {
              if (held.get(path)?.token !== token) return;
              held.delete(path);
              const current = await readLock(path);
              if (current?.token === token) await unlink(path);
            },
          };
        } catch (error) {
          if (errorCode(error) !== 'EEXIST') throw error;
          const current = await readLock(path);
          if (!lockStale(current)) {
            // A live owner of this session id: we still take over in-process
            // only when the PID is ours (re-activate).
            if (current?.pid === process.pid) {
              held.set(path, { token: current.token, path });
              return {
                async release() {
                  held.delete(path);
                  await unlink(path);
                },
              };
            }
            throw new Error(`draft session ${identity.session} is still running`);
          }
          await unlink(path);
        }
      }
      throw new Error('could not take the draft session lock');
    },

    async findOfferable(query) {
      const project = checkProjectId(query.project);
      const host = checkDraftHost(query.host);
      const now = query.now ?? Date.now();
      const dir = join(projectDrafts(layout, project), host);
      let names: string[];
      try {
        names = await fsp.readdir(dir);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return undefined;
        throw error;
      }
      let best: DraftDocument | undefined;
      for (const name of names) {
        const session = sessionOfDraftName(name);
        if (!session) continue;
        if (query.session !== undefined && session === query.session) continue;
        const id = { project, host, session };
        if (await liveLock(lockOf(id))) continue;
        const document = await readDocument(join(dir, name));
        if (!document || !draftIsOfferable(document, now)) continue;
        if (document.header.project !== project || document.header.host !== host) continue;
        if (!best || document.header.capturedAt > best.header.capturedAt) best = document;
      }
      return best;
    },

    async cleanup(now) {
      const at = now ?? Date.now();
      let removed = 0;
      const walk = async (dir: string): Promise<void> => {
        let entries: import('node:fs').Dirent[];
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch (error) {
          if (errorCode(error) === 'ENOENT') return;
          throw error;
        }
        removed += await removeStaleTemps(dir, at);
        for (const entry of entries) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(path);
            continue;
          }
          if (entry.name.endsWith('.draft')) {
            const read = await readStoreFile(path, FILE_MAX, repairs);
            let drop = read.status !== 'ok';
            if (read.status === 'ok') {
              const decoded = decodeDraft(read.bytes);
              drop = !decoded.ok || draftExpired(decoded.document, at);
            }
            if (drop) {
              await unlink(path);
              await unlink(path.replace(/\.draft$/, '.lock'));
              removed++;
            }
          } else if (entry.name.endsWith('.lock')) {
            const body = await readLock(path);
            const draftPath = path.replace(/\.lock$/, '.draft');
            if (lockStale(body) && !(await exists(draftPath))) {
              await unlink(path);
              removed++;
            }
          }
        }
      };
      await walk(layout.drafts);
      return { removed };
    },
  };
}

export async function ensureDraftDir(layout: StoreLayout, projectId: string, host: DraftHost, repairs?: ModeRepairs) {
  await ensurePrivateDir(join(projectDrafts(layout, projectId), host), layout.roots.state, repairs);
}

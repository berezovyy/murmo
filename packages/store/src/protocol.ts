// The store protocol a session without a real file system API (Claude's
// plugin runtime) speaks to the helper, which owns the files. One JSON request,
// one JSON reply. The helper (phase 10, Rust: rust/src/protocol.rs) and the
// Node handler (./node/server.ts) answer it the same way.
//
// Draft rescue goes through here too: the helper owns the drafts files and
// the session's liveness lock, so `drafts.lock` is held by the helper process
// (which exits with its Claude session). Draft ops reply with the `Drafts`
// results of ./draft.ts as they are, the identity in `draft` (the helper
// stamps every request with its own numeric `id`); `project.id` names the project a
// session's directory belongs to (its repository root, else the directory).
import { LOG_KINDS, type LogKind } from './layout.ts';

/** A draft identity on the wire; the store checks its fields. */
export interface DraftWireId {
  readonly project: string;
  readonly host: string;
  readonly session: string;
}

export type StoreRequest =
  | { readonly op: 'storage.get'; readonly plugin: string; readonly key: string }
  | {
      readonly op: 'storage.set';
      readonly plugin: string;
      readonly key: string;
      readonly value: unknown;
      readonly expected?: number;
    }
  | { readonly op: 'storage.delete'; readonly plugin: string; readonly key: string }
  | { readonly op: 'private.get' }
  | { readonly op: 'generation.get' }
  | { readonly op: 'words.add'; readonly word: string; readonly learned: boolean; readonly projectId?: string }
  | { readonly op: 'log.append'; readonly kind: LogKind; readonly session: string; readonly lines: readonly string[] }
  | { readonly op: 'project.id'; readonly cwd: string }
  | {
      readonly op: 'drafts.save';
      readonly draft: DraftWireId;
      readonly text: string;
      readonly cursorUTF16: number;
      readonly revision: number;
      readonly now?: number;
      readonly attempted?: boolean;
    }
  | { readonly op: 'drafts.read' | 'drafts.delete' | 'drafts.lock' | 'drafts.unlock'; readonly draft: DraftWireId }
  | { readonly op: 'drafts.markAttempted'; readonly draft: DraftWireId; readonly now?: number }
  | {
      readonly op: 'drafts.offer';
      readonly project: string;
      readonly host: string;
      readonly session?: string;
      readonly now?: number;
    }
  | { readonly op: 'drafts.cleanup'; readonly now?: number };

export type StoreReply =
  | { readonly status: 'ok'; readonly value?: unknown; readonly revision?: number }
  | {
      readonly status: 'quota' | 'denied' | 'busy' | 'error' | 'conflict';
      readonly reason?: string;
      readonly revision?: number;
    };

const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number';

/** An optional field is absent or of its type; `null` is neither. */
const optional = <T>(v: unknown, is: (v: unknown) => v is T): boolean => v === undefined || is(v);

function draftId(value: unknown): DraftWireId | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  return isString(v.project) && isString(v.host) && isString(v.session)
    ? { project: v.project, host: v.host, session: v.session }
    : undefined;
}

const nowOf = (r: Record<string, unknown>) => (isNumber(r.now) ? { now: r.now } : {});

/** The request in `value`, or undefined when it isn't a well-formed one. */
export function parseStoreRequest(value: unknown): StoreRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  switch (r.op) {
    case 'storage.get':
    case 'storage.delete':
      return isString(r.plugin) && isString(r.key) ? { op: r.op, plugin: r.plugin, key: r.key } : undefined;
    case 'storage.set':
      if (!isString(r.plugin) || !isString(r.key) || !Object.hasOwn(r, 'value')) return undefined;
      return {
        op: r.op,
        plugin: r.plugin,
        key: r.key,
        value: r.value,
        ...(typeof r.expected === 'number' ? { expected: r.expected } : {}),
      };
    case 'private.get':
    case 'generation.get':
      return { op: r.op };
    case 'words.add':
      if (!isString(r.word) || typeof r.learned !== 'boolean') return undefined;
      if (r.projectId !== undefined && !isString(r.projectId)) return undefined;
      return {
        op: r.op,
        word: r.word,
        learned: r.learned,
        ...(isString(r.projectId) ? { projectId: r.projectId } : {}),
      };
    case 'log.append':
      return (LOG_KINDS as readonly unknown[]).includes(r.kind) &&
        isString(r.session) &&
        Array.isArray(r.lines) &&
        r.lines.every(isString)
        ? { op: r.op, kind: r.kind as LogKind, session: r.session, lines: r.lines as string[] }
        : undefined;
    case 'project.id':
      return isString(r.cwd) ? { op: r.op, cwd: r.cwd } : undefined;
    case 'drafts.save': {
      const draft = draftId(r.draft);
      if (!draft || !isString(r.text) || !isNumber(r.cursorUTF16) || !isNumber(r.revision)) return undefined;
      if (!optional(r.now, isNumber) || !optional(r.attempted, (v): v is boolean => typeof v === 'boolean')) {
        return undefined;
      }
      return {
        op: r.op,
        draft,
        text: r.text,
        cursorUTF16: r.cursorUTF16,
        revision: r.revision,
        ...nowOf(r),
        ...(r.attempted === true ? { attempted: true } : {}),
      };
    }
    case 'drafts.read':
    case 'drafts.delete':
    case 'drafts.lock':
    case 'drafts.unlock': {
      const draft = draftId(r.draft);
      return draft ? { op: r.op, draft } : undefined;
    }
    case 'drafts.markAttempted': {
      const draft = draftId(r.draft);
      return draft && optional(r.now, isNumber) ? { op: r.op, draft, ...nowOf(r) } : undefined;
    }
    case 'drafts.offer':
      if (!isString(r.project) || !isString(r.host)) return undefined;
      if (!optional(r.session, isString) || !optional(r.now, isNumber)) return undefined;
      return {
        op: r.op,
        project: r.project,
        host: r.host,
        ...(isString(r.session) ? { session: r.session } : {}),
        ...nowOf(r),
      };
    case 'drafts.cleanup':
      return optional(r.now, isNumber) ? { op: r.op, ...nowOf(r) } : undefined;
    default:
      return undefined;
  }
}

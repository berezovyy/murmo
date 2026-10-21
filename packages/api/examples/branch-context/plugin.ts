// Branch context (r14 author "context", ported): typing `;ctx ` replaces the
// trigger with the current branch and, when a matching commit reflog line
// exists, its subject. The preview has no git broker: this reads loose text
// files under `.git/` through bounded project reads, so packed objects and
// worktrees whose gitdir is outside the project are unsupported. No network
// lookup: `network` is declaration-only until phase 32.
import type { Effect, PluginContext, PluginFactory } from '@murmo/api';

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** Strips controls and bidi overrides from text that goes into the draft. */
const clean = (value: string, limit = 240) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
  Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' '))
    .slice(0, limit)
    .join('')
    .trim();

async function readText(ctx: PluginContext, path: string): Promise<string | null> {
  if (ctx.signal.cancelled) throw new Error('cancelled');
  const result = await ctx.project.read(path);
  if (result.status === 'not-found') return null;
  if (result.status !== 'ok' || result.text === undefined) throw new Error(`${path}: ${result.status}`);
  return result.text;
}

async function gitContext(ctx: PluginContext): Promise<{ branch: string; subject: string }> {
  const head = (await readText(ctx, '.git/HEAD'))?.trim();
  if (!head) throw new Error('no .git/HEAD inside the project');
  let branch = '(detached)';
  let oid = OID.test(head) ? head : null;
  if (!oid) {
    if (!head.startsWith('ref: refs/heads/')) throw new Error('unsupported HEAD');
    const ref = head.slice(5);
    if (ref.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('invalid branch ref');
    branch = ref.slice('refs/heads/'.length);
    const loose = (await readText(ctx, `.git/${ref}`))?.trim() ?? null;
    oid = loose && OID.test(loose) ? loose : null;
  }
  let subject = '(unavailable: no matching commit reflog)';
  const log = oid ? await readText(ctx, '.git/logs/HEAD') : null;
  for (const line of (log ?? '').trimEnd().split('\n').reverse()) {
    const tab = line.indexOf('\t');
    if (tab < 0 || line.slice(0, tab).split(' ')[1] !== oid) continue;
    const commit = /^commit(?: \((?:initial|amend)\))?: (.*)$/.exec(line.slice(tab + 1));
    if (commit?.[1]) {
      subject = clean(commit[1]);
      break;
    }
  }
  return { branch: clean(branch), subject };
}

export default ((settings) => {
  const trigger = typeof settings.trigger === 'string' ? settings.trigger : ';ctx';
  const status = (ctx: PluginContext, text: string): Effect[] =>
    ctx.host.caps.status ? [{ type: 'status', text: `context: ${text}`, baseVersion: ctx.draft.version }] : [];
  return {
    name: 'branch-context',
    version: '0.1.0',
    permissions: ['draft:read', 'draft:write', 'fs:project-read'],
    async onChange(change, ctx): Promise<Effect[]> {
      const d = change.draft;
      const token = `${trigger} `;
      const from = d.cursor - token.length;
      if (change.origin !== 'typed' || from < 0 || d.text.slice(from, d.cursor) !== token) return [];
      if (from > 0 && !/\s/.test(d.text[from - 1] ?? '')) return [];
      if (!d.typedSpans.some(([a, b]) => a <= from && b >= d.cursor)) return [];
      const e = ctx.host.caps.edit;
      if (!e.atomic || !e.multiline || !e.exactRestore || !e.certainties.includes(d.certainty)) {
        return status(ctx, 'needs atomic multiline edits with exact undo');
      }
      try {
        const git = await gitContext(ctx);
        if (ctx.signal.cancelled) return [];
        const insert = `Context:\nBranch: ${git.branch}\nCommit: ${git.subject}\n`;
        const edit = { from, to: d.cursor, insert, baseVersion: d.version, undoable: true };
        return [{ type: 'edit', edit: { ...edit, label: 'branch context' } }];
      } catch (error) {
        return ctx.signal.cancelled ? [] : status(ctx, clean((error as Error).message, 180));
      }
    },
  };
}) satisfies PluginFactory;

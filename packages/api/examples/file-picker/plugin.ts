// `@file`-style picker (r14 author "files", ported): typing `~f:query` shows
// matching project paths. There is no file-listing broker in the preview, so the
// plugin reads a host-generated index (`.murmo-files/index.json` plus shards)
// through bounded project reads; the index's freshness is the generator's
// promise, not the broker's. Long loops yield through the injected clock so the
// call stays inside its deadline.
import type { Effect, MenuItem, PluginContext, PluginFactory } from '@murmo/api';

const TRIGGER = /(?:^|\s)(~f:(\S*))$/u;
const MAX_SHARDS = 16;
const MAX_PATHS = 20_000;

const safePath = (p: unknown): p is string =>
  typeof p === 'string' &&
  p.length > 0 &&
  p.length <= 4096 &&
  !p.startsWith('/') &&
  !p.split('/').includes('..') &&
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
  !/[\\\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(p);

/** Subsequence match; lower is better, Infinity is no match. */
function rank(path: string, query: string): number {
  let at = 0;
  let score = 0;
  for (const ch of query) {
    const found = path.indexOf(ch, at);
    if (found < 0) return Number.POSITIVE_INFINITY;
    score += found - at - ('/._-'.includes(path[found - 1] ?? '/') ? 8 : 0);
    at = found + ch.length;
  }
  return score + path.length / 1000;
}

export default ((settings) => {
  const indexPath = typeof settings.indexPath === 'string' ? settings.indexPath : '.murmo-files/index.json';
  const limit = typeof settings.limit === 'number' ? settings.limit : 12;
  let paths: string[] | null = null;
  let problem = '';
  let shown: { version: number; from: number; to: number; paths: ReadonlySet<string> } | null = null;

  async function readJson(ctx: PluginContext, path: string): Promise<unknown> {
    const result = await ctx.project.read(path);
    if (result.status !== 'ok' || result.text === undefined) throw new Error(`${path}: ${result.status}`);
    return JSON.parse(result.text);
  }
  async function load(ctx: PluginContext): Promise<string[] | null> {
    if (paths) return paths;
    try {
      const index = (await readJson(ctx, indexPath)) as { format?: unknown; shards?: unknown };
      const shards = index.shards;
      if (index.format !== 'murmo-files-v1' || !Array.isArray(shards) || shards.length > MAX_SHARDS) {
        throw new Error('invalid index');
      }
      const all: string[] = [];
      for (const shard of shards) {
        if (!safePath(shard) || ctx.signal.cancelled) return null;
        const page = await readJson(ctx, shard);
        if (!Array.isArray(page) || all.length + page.length > MAX_PATHS) throw new Error('invalid shard');
        all.push(...page.filter(safePath));
        await ctx.clock.sleep(0, ctx.signal);
      }
      paths = all;
      return paths;
    } catch (error) {
      problem = (error as Error).message;
      return null;
    }
  }
  const usable = (ctx: PluginContext) => {
    const { caps } = ctx.host;
    const atEnd = ctx.draft.cursor === ctx.draft.text.length;
    const asyncEdit = caps.edit.atomic && (atEnd ? caps.edit.end : caps.edit.middle);
    const native = caps.inline.nativeCompletion && (atEnd || caps.inline.middle);
    return caps.menu && (asyncEdit || native);
  };

  return {
    name: 'file-picker',
    version: '0.1.0',
    permissions: ['draft:read', 'draft:write', 'fs:project-read'],
    async onChange(change, ctx): Promise<Effect[]> {
      const d = change.draft;
      shown = null;
      const match = TRIGGER.exec(d.text.slice(0, d.cursor));
      const close: Effect = { type: 'menu', items: null, baseVersion: d.version };
      if (!match?.[1] || change.origin !== 'typed' || !usable(ctx)) return [close];
      const from = d.cursor - match[1].length;
      // A pasted trigger must not arm when only its suffix is typed.
      if (!d.typedSpans.some(([a, b]) => a <= from && b >= d.cursor)) return [close];
      const list = await load(ctx);
      if (ctx.signal.cancelled) return [];
      if (!list) return [close, { type: 'status', text: `Files: ${problem}`, baseVersion: d.version }];
      const query = (match[2] ?? '').normalize('NFC').toLowerCase();
      const best = list
        .map((path) => ({ path, score: rank(path.normalize('NFC').toLowerCase(), query) }))
        .filter((x) => Number.isFinite(x.score))
        .sort((a, b) => a.score - b.score || (a.path < b.path ? -1 : 1))
        .slice(0, limit);
      shown = { version: d.version, from, to: d.cursor, paths: new Set(best.map((x) => x.path)) };
      const items = best.map(({ path }): MenuItem => {
        const row = { id: path, label: path, detail: 'Insert relative path' };
        if (!ctx.host.caps.inline.nativeCompletion) return row;
        return { ...row, inlineEdit: { baseVersion: d.version, from, to: d.cursor, insert: path, undoable: true } };
      });
      return [
        { type: 'status', text: null, baseVersion: d.version },
        { type: 'menu', items, baseVersion: d.version },
      ];
    },
    onMenuSelect(item, ctx): Effect[] {
      const d = ctx.draft;
      if (!shown || shown.version !== d.version || !shown.paths.has(item.id) || !usable(ctx)) return [];
      const edit = { from: shown.from, to: shown.to, insert: item.id, baseVersion: d.version, undoable: true };
      return [{ type: 'edit', edit: { ...edit, label: 'file path' } }];
    },
    onProjectFileChange() {
      paths = null;
      shown = null;
      return undefined;
    },
    deactivate() {
      paths = null;
    },
  };
}) satisfies PluginFactory;

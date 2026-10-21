// Prompt linter (r14 author "lint", ported): highlights vague phrases and
// repeated words, summarizes them in the status row, offers quick fixes through
// the `murmo.menu` action (never a guessed raw key: the original F7 was absent on
// real hosts), and warns once at send. Advisory: `guard` stays false, so a fault
// in this plugin never blocks a send.
import type { Draft, Effect, PluginContext, PluginFactory } from '@murmo/api';

interface Issue {
  readonly rule: 'vague' | 'repeated';
  readonly from: number;
  readonly to: number;
  readonly message: string;
  readonly fix?: { readonly from: number; readonly to: number; readonly insert: string; readonly label: string };
}

const MAX_ISSUES = 62;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export default ((settings) => {
  const phrases = typeof settings.vaguePhrases === 'string' ? settings.vaguePhrases.split(',') : ['fix it', 'etc.'];
  const rules = phrases
    .map((phrase) => phrase.trim())
    .filter(Boolean)
    .map((phrase) => ({
      phrase,
      pattern: new RegExp(`(^|[^\\p{L}\\p{N}_])(${escapeRegExp(phrase)})(?=$|[^\\p{L}\\p{N}_])`, 'giu'),
    }));
  let cache: { version: number; text: string; issues: readonly Issue[] } | null = null;
  let warnedText: string | null = null;

  const analyze = (text: string): Issue[] => {
    const issues: Issue[] = [];
    for (const { phrase, pattern } of rules) {
      pattern.lastIndex = 0;
      for (let m = pattern.exec(text); m && issues.length < MAX_ISSUES; m = pattern.exec(text)) {
        const from = m.index + (m[1]?.length ?? 0);
        const to = from + (m[2]?.length ?? 0);
        const fix = phrase.toLowerCase() === 'etc.' ? { from, to, insert: '', label: 'Remove "etc."' } : undefined;
        issues.push({ rule: 'vague', from, to, message: 'vague ask', ...(fix ? { fix } : {}) });
      }
    }
    const words = /[\p{L}\p{N}][\p{L}\p{N}'-]*/gu;
    let previous: { word: string; end: number } | null = null;
    for (let m = words.exec(text); m && issues.length < MAX_ISSUES; m = words.exec(text)) {
      const word = m[0].toLowerCase();
      const end = m.index + m[0].length;
      if (previous && previous.word === word && /^\s+$/.test(text.slice(previous.end, m.index))) {
        const fix = { from: previous.end, to: end, insert: '', label: `Remove repeated "${m[0].slice(0, 30)}"` };
        issues.push({ rule: 'repeated', from: m.index, to: end, message: 'repeated word', fix });
      }
      previous = { word, end };
    }
    return issues;
  };
  const current = (d: Draft) => (cache?.version === d.version && cache.text === d.text ? cache.issues : null);
  const canEdit = (ctx: PluginContext) => {
    const { draft: d, host } = ctx;
    const e = host.caps.edit;
    return e.atomic && e.middle && e.exactRestore && e.certainties.includes(d.certainty);
  };
  const summary = (issues: readonly Issue[]) =>
    issues.length ? `Lint: ${issues.length}, ${[...new Set(issues.map((x) => x.message))].join(', ')}` : null;
  const present = (d: Draft, ctx: PluginContext): Effect[] => {
    const issues = analyze(d.text);
    cache = { version: d.version, text: d.text, issues };
    const c = ctx.host.caps;
    const effects: Effect[] = [];
    if (c.status) effects.push({ type: 'status', text: summary(issues), baseVersion: d.version });
    if (c.highlight !== 'none') {
      const ranges = issues.length ? issues.map((x) => [x.from, x.to] as const) : null;
      effects.push({ type: 'highlight', ranges, baseVersion: d.version });
    }
    // A change closes an open quick-fix menu; typing never reopens it.
    if (c.menu) effects.push({ type: 'menu', items: null, baseVersion: d.version });
    return effects;
  };
  const issueId = (issue: Issue, d: Draft) => `${d.version}:${issue.rule}:${issue.from}:${issue.to}`;

  return {
    name: 'prompt-lint',
    version: '0.1.0',
    permissions: ['draft:read:full', 'draft:write', 'submit', 'submit:observe'],
    guard: false,
    actions: ['murmo.menu'],
    activate(ctx) {
      return present(ctx.draft, ctx);
    },
    onChange(change, ctx) {
      if (change.draft.text !== warnedText) warnedText = null;
      return present(change.draft, ctx);
    },
    onAction(action, ctx): Effect[] {
      const d = ctx.draft;
      if (action !== 'murmo.menu' || !ctx.host.caps.menu) return [];
      const fixes = canEdit(ctx) ? (current(d) ?? []).filter((x) => x.fix) : [];
      const items = fixes.map((x) => ({ id: issueId(x, d), label: x.fix?.label ?? x.message }));
      return [{ type: 'menu', items: items.length ? items : null, baseVersion: d.version }];
    },
    onMenuSelect(item, ctx): Effect[] {
      const d = ctx.draft;
      const fix = (current(d) ?? []).find((x) => issueId(x, d) === item.id)?.fix;
      if (!fix || !canEdit(ctx)) return [];
      const edit = { from: fix.from, to: fix.to, insert: fix.insert, baseVersion: d.version, undoable: true };
      return [{ type: 'edit', edit: { ...edit, label: 'Prompt lint quick fix' } }];
    },
    onBeforeSubmit(tx, ctx) {
      const issues = current(tx.draft) ?? analyze(tx.draft.text);
      if (!issues.length || !ctx.host.caps.submit.block || warnedText === tx.draft.text) return { action: 'send' };
      warnedText = tx.draft.text;
      return { action: 'block', reason: `${summary(issues)}. Send again to continue.` };
    },
    onSubmitCommitted() {
      warnedText = null;
      return undefined;
    },
  };
}) satisfies PluginFactory;

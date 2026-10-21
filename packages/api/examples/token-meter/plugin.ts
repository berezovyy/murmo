// Token meter (r14 author "meter", ported): shows an estimate of the draft's
// tokens and today's committed total, warns once at send when a budget is
// exceeded, and counts only committed sends. `draft:read` is enough: masking
// keeps the length, and the estimate is ceil(UTF-16 length / 4), a proxy, not a
// tokenizer. Totals live in storage per UTC day; storage is single-writer, so
// another session's meter can overwrite this one's count (no CAS in the preview).
import type { Draft, Effect, PluginContext, PluginFactory, PluginStorage } from '@murmo/api';

interface Total {
  tokens: number;
  submissions: number;
}

const STORAGE_KEY = 'meter-v1';
const KEEP_DAYS = 31;

const estimate = (text: string) => Math.ceil(text.length / 4);
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const isTotal = (x: unknown): x is Total =>
  typeof x === 'object' &&
  x !== null &&
  Number.isSafeInteger((x as Total).tokens) &&
  Number.isSafeInteger((x as Total).submissions);

export default ((settings) => {
  const maxPrompt = typeof settings.maxPromptTokens === 'number' ? settings.maxPromptTokens : 8192;
  const dailyBudget = typeof settings.dailyBudgetTokens === 'number' ? settings.dailyBudgetTokens : 100_000;
  const days = new Map<string, Total>();
  let loaded: Promise<void> | undefined;
  let storageState = 'loading';
  let warnedText: string | null = null;

  const load = (storage: PluginStorage) => {
    loaded ??= (async () => {
      const result = await storage.get(STORAGE_KEY);
      if (result.status !== 'ok') {
        storageState = `storage ${result.status}`;
        return;
      }
      const saved = result.value as { version?: unknown; days?: Record<string, unknown> } | undefined;
      for (const [day, total] of Object.entries(saved?.version === 1 ? (saved.days ?? {}) : {})) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && isTotal(total)) days.set(day, { ...total });
      }
      storageState = 'stored';
    })();
    return loaded;
  };
  const today = (ctx: PluginContext) => days.get(utcDay(ctx.clock.wallTimeMs())) ?? { tokens: 0, submissions: 0 };
  const warning = (tokens: number, ctx: PluginContext) => {
    const reasons: string[] = [];
    if (tokens > maxPrompt) reasons.push(`prompt ~${tokens} > ${maxPrompt} tokens`);
    const day = today(ctx).tokens + tokens;
    if (day > dailyBudget) reasons.push(`day ~${day} > ${dailyBudget} tokens`);
    return reasons.join('; ');
  };
  const status = (d: Draft, ctx: PluginContext): Effect[] => {
    if (!ctx.host.caps.status) return [];
    const tokens = estimate(d.text);
    const warn = warning(tokens, ctx);
    let text = `~${tokens} tok; today ~${today(ctx).tokens}`;
    if (warn) text += `; over budget: ${warn}`;
    if (storageState !== 'stored') text += `; ${storageState}`;
    return [{ type: 'status', text, baseVersion: d.version }];
  };

  return {
    name: 'token-meter',
    version: '1.0.0',
    permissions: ['draft:read', 'submit', 'submit:observe'],
    async activate(ctx) {
      await load(ctx.storage);
      return status(ctx.draft, ctx);
    },
    onChange(change, ctx) {
      if (change.draft.text !== warnedText) warnedText = null;
      return status(change.draft, ctx);
    },
    // Advisory, not a guard: the second send of the same text goes through.
    async onBeforeSubmit(tx, ctx) {
      await load(ctx.storage);
      const reason = warning(estimate(tx.draft.text), ctx);
      if (!reason || !ctx.host.caps.submit.block || warnedText === tx.draft.text) return { action: 'send' };
      warnedText = tx.draft.text;
      return { action: 'block', reason: `Token estimate: ${reason}. Send again to continue.` };
    },
    async onSubmitCommitted(event, ctx) {
      await load(ctx.storage);
      const day = utcDay(event.acceptedAtMs ?? ctx.clock.wallTimeMs());
      const total = days.get(day) ?? { tokens: 0, submissions: 0 };
      days.set(day, { tokens: total.tokens + estimate(event.text), submissions: total.submissions + 1 });
      for (const old of [...days.keys()].sort().slice(0, -KEEP_DAYS)) days.delete(old);
      const result = await ctx.storage.set(STORAGE_KEY, { version: 1, days: Object.fromEntries(days) });
      storageState = result.status === 'ok' ? 'stored' : `storage ${result.status}`;
      return status(ctx.draft, ctx);
    },
  };
}) satisfies PluginFactory;

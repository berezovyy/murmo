// QuickJS IIFE entry. Side effects install the globals the Rust bridge calls.
// Fail-open: every export catches and returns a JSON error the loop can ignore.

import { createPluginHost, createSession, type Session } from '@murmo/core';
import { createInProcessExecutor } from '@murmo/executor';
import { asSnap, type CodexAdapter, completeEdit, createAdapter, hostState } from './adapter.ts';
import { createHost } from './host.ts';
import { builtinSpecs, type EngineConfig, installTable, type TableMeta } from './plugins.ts';
import { installTimers, tick } from './timers.ts';

installTimers();

const g = globalThis as Record<string, unknown>;
g.__vmStep = () => 'none';
g.__vmFault = () => 'ok';
g.__decision = null;
g.__loaded = false;
g.__disposed = false;

function readJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

let adapter: CodexAdapter | undefined;
let session: Session | undefined;
let lastInlineBefore: ReturnType<CodexAdapter['draft']> | undefined;

function boot(): void {
  const host = createHost();
  const config = readJson<EngineConfig>(g.__configJSON, {});
  const tableMeta = readJson<TableMeta>(g.__tableMetaJSON, {});
  const asset = g.__inlineAsset;
  if (asset instanceof ArrayBuffer) installTable(new Uint8Array(asset), tableMeta);
  else if (ArrayBuffer.isView(asset)) installTable(new Uint8Array(asset.buffer), tableMeta);

  const specs = builtinSpecs(config);
  adapter = createAdapter(host, {
    menu: false,
    ghost: false,
    ...(config.hostVersion ? { version: config.hostVersion } : {}),
  });
  const executor = createInProcessExecutor();
  const runner = createPluginHost({
    specs,
    executor,
    grants: {
      autocorrect: ['draft:read', 'draft:write'],
      shortcuts: ['draft:read', 'draft:write'],
      menu: ['draft:read'],
      rescue: ['draft:read', 'draft:write', 'submit:observe'],
    },
  });
  session = createSession({
    adapter,
    runner,
    keyBursts: true,
    order: specs.map((s) => s.id),
  });
}

g.__init = () => {
  try {
    boot();
    void session?.ready.then(
      () => {
        g.__loaded = true;
      },
      (error) => {
        g.__loaded = false;
        adapter?.notices.push(String(error));
      },
    );
    return JSON.stringify({ ok: true });
  } catch (error) {
    return JSON.stringify({ ok: false, why: String(error) });
  }
};

g.__event = (line: string) => {
  try {
    if (!adapter) return '{"value":"pass"}';
    const e = JSON.parse(line) as {
      kind: string;
      key?: string;
      gesture?: string;
      origin?: string;
      splice?: { from: number; to: number; length: number };
      snapshot?: unknown;
    };
    if (e.snapshot) adapter.applyNative(asSnap(e.snapshot));
    let value: string | undefined;
    if (e.kind === 'key' && e.key) value = adapter.key(e.key);
    if (e.kind === 'submit') adapter.startSubmit(e.gesture === 'queue' ? 'queue' : 'send');
    if (e.kind === 'change') {
      adapter.publish({
        draft: adapter.draft(),
        origin: e.origin === 'typed' || e.origin === 'paste' || e.origin === 'history' ? e.origin : 'unknown',
      });
    }
    return JSON.stringify({
      value,
      stats: session?.stats() ?? {},
      managedDraft: adapter.draft(),
      hostState: hostState(adapter.snap),
    });
  } catch (error) {
    return JSON.stringify({ value: 'pass', error: String(error) });
  }
};

g.__inline = (line: string) => {
  try {
    if (!adapter) return '{"action":"native"}';
    const e = JSON.parse(line) as {
      id: string;
      origin: string;
      key: string;
      inputText: string;
      deltas: InlineDeltas;
    };
    const d = adapter.draft();
    lastInlineBefore = d;
    const plan = adapter.evaluateInline({
      transactionId: e.id,
      version: d.version,
      text: d.text,
      cursor: d.cursor,
      certainty: d.certainty,
      typedSpans: d.typedSpans,
      origin: e.origin === 'paste' ? 'paste' : e.origin === 'typed' ? 'typed' : 'unknown',
      deltas: e.deltas ?? [],
      key: { id: e.key === ' ' ? 'space' : e.key, inputText: e.inputText ?? '', from: d.cursor, to: d.cursor },
      state: hostState(adapter.snap),
    });
    return JSON.stringify(plan);
  } catch {
    return '{"action":"native"}';
  }
};

type InlineDeltas = {
  origin: 'typed' | 'paste' | 'unknown';
  from: number;
  to: number;
  insert: string;
}[];

g.__inlineDone = (line: string) => {
  try {
    if (!adapter) return 'ok';
    const e = JSON.parse(line) as {
      id: string;
      origin: string;
      status: 'applied' | 'fallback' | 'stale' | 'cancelled';
      replaced?: boolean;
      snapshot?: unknown;
      splice?: { from: number; to: number; length: number };
    };
    if (e.snapshot) adapter.applyNative(asSnap(e.snapshot));
    const replay = adapter.lastPlan && 'replay' in adapter.lastPlan ? adapter.lastPlan.replay : undefined;
    let replayText = replay?.before.text;
    for (const delta of replay?.deltas ?? []) {
      replayText = replayText?.slice(0, delta.from) + delta.insert + replayText?.slice(delta.to);
    }
    const valid = e.status === 'applied' && replay && replayText === adapter.snap.draft.text;
    if (valid && replay) adapter.spans = replay.typedSpans.map((r) => [r[0], r[1]]);
    const d = adapter.draft();
    adapter.ackInline({
      transactionId: e.id,
      status: e.status,
      text: d.text,
      cursor: d.cursor,
      version: d.version,
    });
    if (valid && replay) {
      adapter.publish({
        draft: d,
        origin: e.replaced ? 'plugin' : e.origin === 'typed' ? 'typed' : 'unknown',
        before: replay.before,
        deltas: replay.deltas,
      });
    } else if (lastInlineBefore) {
      adapter.publish({ draft: d, origin: 'unknown', before: lastInlineBefore });
    }
    lastInlineBefore = undefined;
    adapter.lastPlan = null;
    return 'ok';
  } catch {
    return 'ok';
  }
};

g.__tick = () => {
  tick();
  return 'ok';
};

g.__permit = (id: string) => String(adapter?.pendingEdits.has(Number(id)) === true);

g.__complete = (line: string) => {
  if (!adapter) return 'ok';
  return completeEdit(adapter, line);
};

g.__decisionGet = () => {
  const d = g.__decision;
  return typeof d === 'string' ? d : 'null';
};

g.__dispose = () => {
  void session?.dispose().then(() => {
    g.__disposed = true;
  });
  return 'ok';
};

g.__rpcResult = (_line: string) => 'ok';

export function engineGlobals(): Record<string, unknown> {
  return g;
}

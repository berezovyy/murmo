import type { Executor, PluginFactory } from '@murmo/api/adapter';
import { createInProcessExecutor } from '@murmo/executor';
import { createNodeIsolatedExecutor, helperBinary } from '@murmo/executor/node';
import { createQuickJSExecutor } from './quickjs.ts';

export const EXECUTORS = ['in-process', 'quickjs', 'helper'] as const;
export type ExecutorName = (typeof EXECUTORS)[number];

export function parseExecutors(value: string | undefined): readonly ExecutorName[] {
  if (!value || value === 'all') return EXECUTORS;
  if (!(EXECUTORS as readonly string[]).includes(value)) {
    throw new Error(`invalid --executor ${value}; expected in-process|quickjs|helper|all`);
  }
  return [value as ExecutorName];
}

export async function loadFactory(source: string): Promise<PluginFactory> {
  const loaded = (await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`)) as {
    default?: PluginFactory;
  };
  if (typeof loaded.default !== 'function') throw new Error('plugin entry must export default factory');
  return loaded.default;
}

type QuickJSModule = typeof import('quickjs-emscripten');

/** QuickJS-in-Node comes from a dev dependency; the packed CLI ships the real helper instead. */
async function quickjsModule(): Promise<QuickJSModule | undefined> {
  try {
    return await import('quickjs-emscripten');
  } catch {
    return undefined;
  }
}

/** Why an executor can't run here, or undefined when it can. */
export async function executorUnavailable(name: ExecutorName): Promise<string | undefined> {
  if (name === 'helper' && !helperPath()) {
    return 'murmo-plugin-host is not built for this platform; helper route skipped (phase 26)';
  }
  if (name === 'quickjs' && !(await quickjsModule())) {
    return 'QuickJS-in-Node is a development tool and is not shipped; the helper runs the same QuickJS engine';
  }
  return undefined;
}

export async function createNamedExecutor(name: ExecutorName): Promise<Executor> {
  if (name === 'in-process') return createInProcessExecutor({ pressure: () => 1 });
  if (name === 'helper') return createNodeIsolatedExecutor({ pressure: () => 1 });
  const quickjs = await quickjsModule();
  if (!quickjs) throw new Error(await executorUnavailable('quickjs'));
  return createQuickJSExecutor({ QuickJS: await quickjs.getQuickJS() });
}

/** Locate the real helper; `undefined` means this platform has no binary yet (phase 26). */
export function helperPath(): string | undefined {
  try {
    return helperBinary();
  } catch {
    return undefined;
  }
}

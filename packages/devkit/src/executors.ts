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

export async function createNamedExecutor(name: ExecutorName): Promise<Executor> {
  if (name === 'in-process') return createInProcessExecutor({ pressure: () => 1 });
  if (name === 'helper') return createNodeIsolatedExecutor({ pressure: () => 1 });
  const { getQuickJS } = await import('quickjs-emscripten');
  return createQuickJSExecutor({ QuickJS: await getQuickJS() });
}

/** Locate the real helper; `undefined` means this platform has no binary yet (phase 26). */
export function helperPath(): string | undefined {
  try {
    return helperBinary();
  } catch {
    return undefined;
  }
}

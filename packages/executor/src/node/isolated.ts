import { createIsolatedExecutor, type IsolatedExecutor, type IsolatedExecutorOptions } from '../helper.ts';
import { helperBinary } from './binary.ts';
import { createStdioTransport } from './stdio.ts';

export interface NodeIsolatedExecutorOptions extends Omit<IsolatedExecutorOptions, 'connect'> {
  readonly bin?: string;
}

/** Isolated Executor that spawns `murmo-plugin-host` on stdio (Pi, OpenCode, tests). */
export function createNodeIsolatedExecutor(options: NodeIsolatedExecutorOptions = {}): IsolatedExecutor {
  const bin = helperBinary(options.bin);
  return createIsolatedExecutor({
    ...options,
    connect: () => createStdioTransport({ bin }),
  });
}

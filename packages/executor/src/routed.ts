// One Executor for a session that runs built-ins and third-party plugins:
// built-ins (`sandbox: false`) stay in-process, every third-party spec
// (`sandbox: true`) goes to the isolated helper, which is started only when
// the first one loads. A third-party plugin never runs in the host process,
// whatever the session was given (docs/02-architecture.md, executors).

import type { ExecutionOptions, Executor, PluginDescriptor, PluginSpec } from '@murmo/api/adapter';
import { executorFault } from './fault.ts';

export interface RoutedExecutorOptions {
  /** Built-ins. Its clock is the session's clock. */
  readonly trusted: Executor;
  /** Makes the isolated executor on first use; throwing refuses only third-party loads. */
  readonly isolated: () => Executor;
}

export interface RoutedStats {
  readonly kind: 'routed';
  readonly trusted: unknown;
  readonly isolated?: unknown;
  /** Only the trusted side takes the session down; a dead helper faults its plugins. */
  readonly down: boolean;
}

export function createRoutedExecutor(options: RoutedExecutorOptions): Executor {
  const { trusted } = options;
  let isolated: Executor | undefined;
  const owner = new Map<string, Executor>();
  const sideOf = (id: string): Executor => owner.get(id) ?? trusted;

  return {
    kind: trusted.kind,
    clock: trusted.clock,
    kindOf: (spec) => (spec.sandbox ? 'isolated' : (trusted.kindOf?.(spec) ?? trusted.kind)),
    async load(spec: PluginSpec): Promise<PluginDescriptor> {
      let side = trusted;
      if (spec.sandbox) {
        try {
          isolated ??= options.isolated();
        } catch (error) {
          throw executorFault(
            'exception',
            `third-party plugins need the isolated plugin host: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        side = isolated;
      }
      const descriptor = await side.load(spec);
      owner.set(spec.id, side);
      return descriptor;
    },
    run(id: string, hook, input, context, opts: ExecutionOptions) {
      return sideOf(id).run(id, hook, input, context, opts);
    },
    async unload(id: string): Promise<void> {
      const side = sideOf(id);
      owner.delete(id);
      await side.unload(id);
    },
    async dispose(): Promise<void> {
      owner.clear();
      await Promise.all([trusted.dispose(), isolated?.dispose()]);
    },
    stats(): RoutedStats {
      const inner = trusted.stats() as { down?: boolean } | undefined;
      return {
        kind: 'routed',
        trusted: inner,
        ...(isolated ? { isolated: isolated.stats() } : {}),
        down: inner?.down === true,
      };
    },
  };
}

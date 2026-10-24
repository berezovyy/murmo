// Stands in for the isolated helper in adapter tests (the helper's OS
// sandbox is refused inside the offline test sandbox): it runs a third-party
// spec's `source` in-process and records each spec it was given, so a test
// can prove a session sent an installed plugin to the third-party side with
// its reviewed grants. Never a production executor: no isolation at all.

import type { Clock } from '@murmo/api';
import type { Executor, PluginSpec } from '@murmo/api/adapter';
import { createInProcessExecutor } from '@murmo/executor';

export function sourceExecutor(loaded: PluginSpec[] = []): (clock: Clock) => Executor {
  return (clock) => {
    const inner = createInProcessExecutor({ clock });
    return {
      kind: 'isolated',
      clock,
      async load(spec) {
        loaded.push(spec);
        const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(spec.source ?? '')}`;
        const mod = (await import(url)) as { default: NonNullable<PluginSpec['factory']> };
        return inner.load({ ...spec, factory: mod.default });
      },
      run: (id, hook, input, ctx, opts) => inner.run(id, hook, input, ctx, opts),
      unload: (id) => inner.unload(id),
      dispose: () => inner.dispose(),
      stats: () => inner.stats(),
    };
  };
}

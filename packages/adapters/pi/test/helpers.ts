import { createPluginHost, createSession, type HostPluginSpec, type Session } from '@murmo/core';
import { testInlinePlugin } from '@murmo/core/testing';
import { createInProcessExecutor } from '@murmo/executor';
import { createPiAdapter, type PiAdapter } from '../src/adapter.ts';
import { createFakePi, type FakePi, FakePiEditor, fakeTuiApi } from './fake-pi.ts';

export interface LivePi {
  readonly env: FakePi;
  readonly adapter: PiAdapter;
  readonly session: Session;
  type(text: string): void;
  key(data: string): void;
  dispose(): Promise<void>;
}

export async function startLive(plugins: readonly HostPluginSpec[] = [testInlinePlugin('murmo')]): Promise<LivePi> {
  const env = createFakePi();
  const { adapter } = createPiAdapter({
    Base: FakePiEditor,
    tuiApi: fakeTuiApi,
    ctx: env.ctx,
    pi: env.host,
    version: '1.3.0',
  });
  const runner = createPluginHost({
    specs: plugins,
    executor: createInProcessExecutor(),
  });
  const session = createSession({ adapter, runner, keyBursts: true, order: plugins.map((p) => p.id) });
  await session.ready;
  await session.settle();
  return {
    env,
    adapter,
    session,
    type(text) {
      for (const ch of text) env.editor.handleInput(ch);
    },
    key(data) {
      env.editor.handleInput(data);
    },
    async dispose() {
      await session.dispose();
      await adapter.dispose();
    },
  };
}

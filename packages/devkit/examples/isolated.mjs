import assert from 'node:assert/strict';
import { createMemoryStorage, createPluginHost, createSession } from '@murmo/core';
import { createInProcessExecutor } from '@murmo/executor';
import { createFakeDriver, FakeAdapter } from '@murmo/fake-host';

const source = `export default () => ({
  name: 'status-counter',
  version: '1.0.0',
  permissions: ['draft:read'],
  onChange(change, ctx) {
    if (!ctx.host.caps.status) return [];
    return [{ type: 'status', text: change.draft.text.length + ' chars', baseVersion: ctx.draft.version }];
  },
});`;

const adapter = new FakeAdapter();
const executor = createInProcessExecutor();
const factory = () => ({
  name: 'status-counter',
  version: '1.0.0',
  permissions: ['draft:read'],
  onChange(change, ctx) {
    if (!ctx.host.caps.status) return [];
    return [{ type: 'status', text: `${change.draft.text.length} chars`, baseVersion: ctx.draft.version }];
  },
});
const runner = createPluginHost({
  specs: [
    {
      id: 'counter',
      builtin: false,
      source,
      factory,
      manifest: {
        name: 'status-counter',
        version: '1.0.0',
        api: '^2.0.0',
        entry: 'plugin.mjs',
        permissions: [{ name: 'draft:read', reason: 'count' }],
        capabilities: { required: { readDraft: true, status: true }, optional: {} },
        settingsSchema: { type: 'object', properties: {} },
      },
    },
  ],
  executor,
  storage: createMemoryStorage(),
});
const session = createSession({ adapter, runner, keyBursts: true });
try {
  await session.ready;
  await createFakeDriver(adapter, session).type('hello');
  assert.equal(adapter.status, '[plugin counter] 5 chars');
  console.log(adapter.status);
} finally {
  await session.dispose();
}

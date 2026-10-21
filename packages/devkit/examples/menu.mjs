import assert from 'node:assert/strict';
import { createMemoryStorage, createPluginHost, createSession } from '@murmo/core';
import { createInProcessExecutor } from '@murmo/executor';
import { createFakeDriver, FakeAdapter } from '@murmo/fake-host';

const factory = () => ({
  name: 'sample-menu',
  version: '1.0.0',
  permissions: ['draft:read', 'draft:write'],
  onChange(change, ctx) {
    const d = change.draft;
    const from = d.cursor - 7;
    const c = ctx.host.caps;
    const typed =
      from >= 0 &&
      d.text.slice(from, d.cursor) === '~sample' &&
      d.typedSpans.some(([a, b]) => a <= from && b >= d.cursor);
    const usable = c.menu && (c.edit.atomic || c.inline?.nativeCompletion);
    return [
      {
        type: 'menu',
        baseVersion: d.version,
        items:
          typed && usable
            ? [
                {
                  id: 'hello',
                  label: 'Insert hello',
                  ...(c.inline?.nativeCompletion
                    ? { inlineEdit: { baseVersion: d.version, from, to: d.cursor, insert: 'hello', undoable: false } }
                    : {}),
                },
              ]
            : null,
      },
    ];
  },
  onMenuSelect(item, ctx) {
    const d = ctx.draft;
    const from = d.cursor - 7;
    if (item.id !== 'hello' || d.text.slice(from, d.cursor) !== '~sample') return [];
    return [{ type: 'edit', edit: { from, to: d.cursor, insert: 'hello', baseVersion: d.version, undoable: true } }];
  },
});

const adapter = new FakeAdapter();
const source = `export default ${factory.toString()}`;
const runner = createPluginHost({
  specs: [
    {
      id: 'sample-menu',
      builtin: false,
      source,
      factory,
      manifest: {
        name: 'sample-menu',
        version: '1.0.0',
        api: '^2.0.0',
        entry: 'plugin.mjs',
        permissions: [
          { name: 'draft:read', reason: 'menu' },
          { name: 'draft:write', reason: 'insert' },
        ],
        capabilities: { required: { readDraft: true, menu: true }, optional: {} },
        settingsSchema: { type: 'object', properties: {} },
      },
    },
  ],
  executor: createInProcessExecutor(),
  storage: createMemoryStorage(),
});
const session = createSession({ adapter, runner, keyBursts: true });
try {
  await session.ready;
  const driver = createFakeDriver(adapter, session);
  await driver.type('~sample');
  assert.equal(adapter.menu?.[0]?.id, 'hello');
  await driver.key('Tab');
  assert.equal(adapter.getDraft().text, 'hello');
  assert.equal(adapter.requests.length, 0);
  console.log('hello (no submit)');
} finally {
  await session.dispose();
}

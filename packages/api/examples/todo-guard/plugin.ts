// TODO guard: blocks a send while the prompt still says TODO. A guard must see
// pasted text too, so it asks for `draft:read:full`; it blocks, never rewrites.
// `guard: true` makes every failure of this plugin block the send.
import type { PluginFactory } from '@murmo/api';

const TODO = /\bTODO\b/;

export default ((settings) => {
  const reason = typeof settings.reason === 'string' ? settings.reason : 'The prompt still has a TODO';
  return {
    name: 'todo-guard',
    version: '1.0.0',
    guard: true,
    permissions: ['draft:read:full', 'submit'],
    onBeforeSubmit(tx) {
      return TODO.test(tx.draft.text) ? { action: 'block', reason } : { action: 'send' };
    },
  };
}) satisfies PluginFactory;

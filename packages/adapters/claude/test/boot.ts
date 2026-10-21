import type { PluginFactory } from '@murmo/api';
import todoGuard from '@murmo/api/examples/todo-guard';
import { testInlinePlugin } from '@murmo/core/testing';
import { type ClaudeHost, type ClaudeSessionOptions, createClaudeHost } from '../src/session.ts';
import { backspace, FakeClaude, paste, typeChars } from './fake-runtime.ts';

const reader: PluginFactory = () => ({
  name: 'reader',
  version: '1',
  permissions: ['draft:read'],
  onChange() {
    return [];
  },
});

export async function boot(options: ClaudeSessionOptions = {}): Promise<{ fake: FakeClaude; host: ClaudeHost }> {
  const fake = new FakeClaude();
  const plugins = options.plugins ?? [
    testInlinePlugin('ac', { replacements: { ';tst': 'tested', ';rvw': 'Review this.' } }),
    { id: 'todo-guard', builtin: true, factory: todoGuard, requiredGuard: true },
    { id: 'reader', builtin: true, factory: reader },
  ];
  const host = createClaudeHost({ skipProbes: true, ...options, plugins });
  await host.start(fake.$);
  return { fake, host };
}

export async function type(host: ClaudeHost, fake: FakeClaude, text: string): Promise<void> {
  await typeChars((event, next) => host.adapter.handleEdit(event, next), fake, text);
}

export async function pasteText(host: ClaudeHost, fake: FakeClaude, text: string): Promise<void> {
  await paste((event, next) => host.adapter.handleEdit(event, next), fake, text);
}

export async function hitBackspace(host: ClaudeHost, fake: FakeClaude, times = 1): Promise<void> {
  await backspace((event, next) => host.adapter.handleEdit(event, next), fake, times);
}

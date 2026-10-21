// Claude plugin entry. `hooks/hooks.json` points here. No Node, no reload timer.

import { type ClaudeHost, createClaudeHost } from './session.ts';
import {
  type AutocompleteInput,
  type AutocompleteResult,
  CLASSIC_GUARD_TIMEOUT_MS,
  type ClassicSubmitInput,
  type ClaudeRegister,
  type PromptChangeInput,
  type PromptEditInput,
  type PromptSubmitInput,
  type RenderEvent,
} from './types.ts';

let host: ClaudeHost | undefined;

export function register(on: ClaudeRegister): void {
  on('session.start', async ($, event, next) => {
    const result = await next(event);
    host = createClaudeHost();
    try {
      await host.start($);
    } catch (error) {
      host.adapter.notices.push(`startup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return result;
  });

  on('session.end', async (_$, event, next) => {
    await host?.dispose();
    host = undefined;
    return next(event);
  });

  on('prompt.edit', async (_$, event: PromptEditInput, next) => {
    const current = host;
    if (!current?.alive) return next(event);
    try {
      return await current.adapter.handleEdit(event, next);
    } catch {
      return next(event);
    }
  });

  on('prompt.change', (_$, event: PromptChangeInput, next) => {
    if (host?.alive) host.adapter.handleChange(event);
    return next(event);
  });

  on('prompt.submit', async (_$, event: PromptSubmitInput, next) => {
    const current = host;
    if (!current?.alive) return { drop: 'Murmo is still loading' };
    try {
      return await current.adapter.handleSubmit(event, next);
    } catch {
      return { drop: 'platform submit failed — blocked' };
    }
  });

  on('classic.UserPromptSubmit', { timeout: CLASSIC_GUARD_TIMEOUT_MS }, async (_$, event: ClassicSubmitInput, next) => {
    const current = host;
    if (!current?.alive) return next(event);
    try {
      return await current.adapter.handleClassic(event, next);
    } catch {
      return { block: 'final guard failed — blocked' };
    }
  });

  on('prompt.autocomplete', async (_$, event: AutocompleteInput, next) => {
    const hostRows = await next(event);
    if (!host?.alive) return hostRows;
    return host.adapter.handleAutocomplete(event, hostRows as AutocompleteResult);
  });

  on('ui.render', { component: 'PromptHint' }, async (_$, event: RenderEvent, next) => {
    if (!host) return next(event);
    host.adapter.hint(event.props);
    host.adapter.measureHint(event.props.hint);
    const tail = host.adapter.statusLine();
    return next({ ...event, props: { ...event.props, ...(tail ? { tail } : {}) } });
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, event: RenderEvent, next) => {
    const previous = await next(event);
    if (!host?.alive) return previous;
    return host.adapter.handleAbove(previous, $.ui.resolve(event));
  });
}

/** Tests inspect the live host; production never imports this. */
export function debugHost(): ClaudeHost | undefined {
  return host;
}

export function resetHost(): void {
  host = undefined;
}

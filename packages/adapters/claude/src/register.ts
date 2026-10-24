// Claude plugin entry. `hooks/hooks.json` points here. No Node, no reload timer.

import { readPluginSelection } from '@murmo/store';
import { bytesOf, textOf } from './decode.ts';
import { CLAUDE_EVENT_TIMEOUT_MS, ingestClaudeHook } from './events.ts';
import { HELPER_PATHS, packageFromPluginRoot } from './payload.ts';
import { type ClaudeHost, createClaudeHost } from './session.ts';
import {
  type AutocompleteInput,
  type AutocompleteResult,
  CLASSIC_GUARD_TIMEOUT_MS,
  type ClassicSubmitInput,
  type ClaudeRegister,
  type FsBytes,
  type HostServices,
  type PromptChangeInput,
  type PromptEditInput,
  type PromptSubmitInput,
  type RenderEvent,
} from './types.ts';

let host: ClaudeHost | undefined;

function joinPath(base: string, path: string): string {
  if (!base) return path;
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

function asText(raw: string | FsBytes): string {
  return textOf(raw);
}

async function onClassicPreToolUse(_rt: unknown, event: unknown, next: (event: unknown) => unknown): Promise<unknown> {
  const broker = host?.events;
  if (!broker) return next(event);
  const payload = event && typeof event === 'object' ? (event as Record<string, unknown>) : {};
  const decision = await ingestClaudeHook(broker, 'PreToolUse', payload, 'claude');
  if (decision.action === 'block') return { permissionDecision: 'deny', permissionDecisionReason: decision.reason };
  return next(event);
}

async function onClassicStop(_rt: unknown, event: unknown, next: (event: unknown) => unknown): Promise<unknown> {
  const broker = host?.events;
  if (broker) {
    const payload = event && typeof event === 'object' ? (event as Record<string, unknown>) : {};
    await ingestClaudeHook(broker, 'Stop', payload, 'claude');
  }
  return next(event);
}

async function onTurnComplete(_rt: unknown, event: unknown, next: (event: unknown) => unknown): Promise<unknown> {
  const broker = host?.events;
  if (broker) {
    const payload = event && typeof event === 'object' ? (event as Record<string, unknown>) : {};
    await ingestClaudeHook(broker, 'turn.complete', payload, 'claude');
  }
  return next(event);
}

export function register(on: ClaudeRegister): void {
  on('session.start', async ($, event, next) => {
    const result = await next(event);
    host = createClaudeHost();
    try {
      // Claude 2.1.30x marketplace analyzer: `$` only as `$.noun.event(...)`
      // at this call site. Primitives go to bootPacked, and what the session
      // keeps using of `$` goes as closures that make exactly those calls.
      const services: HostServices = {
        after: (ms, callback) => $.clock.after(ms, callback),
        spawn: (argv) => $.process.spawn({ argv }),
        fetch: (url, init) => $.http.fetch(url, init),
        repaint: () => $.ui.invalidate('ui.render'),
      };
      const xdgData = await $.env.get('XDG_DATA_HOME');
      const xdgConfig = await $.env.get('XDG_CONFIG_HOME');
      const homeEnv = await $.env.get('HOME');
      const cwd = await $.session.cwd();
      const dataRoot = xdgData ? joinPath(xdgData, 'murmo') : joinPath(homeEnv ?? '', '.local/share/murmo');
      const configRoot = xdgConfig ? joinPath(xdgConfig, 'murmo') : joinPath(homeEnv ?? '', '.config/murmo');
      const candidates = [joinPath(dataRoot, 'package')];
      const fromPlugin = packageFromPluginRoot(`${$.plugin.root}`);
      if (fromPlugin && !candidates.includes(fromPlugin)) candidates.push(fromPlugin);
      let payloadRoot = '';
      let integrityJson = '';
      for (const root of candidates) {
        const integrityPath = joinPath(root, 'integrity.json');
        if (await $.fs.exists(integrityPath)) {
          integrityJson = asText(await $.fs.read(integrityPath));
          payloadRoot = root;
          break;
        }
      }
      let tableRaw: string | FsBytes | undefined;
      let casePolicyJson: string | undefined;
      const helperBinaries: string[] = [];
      if (payloadRoot) {
        for (const path of HELPER_PATHS) {
          const binary = joinPath(payloadRoot, path);
          if (await $.fs.exists(binary)) helperBinaries.push(binary);
        }
        const tablePath = joinPath(payloadRoot, 'data/en/english.bin');
        if (await $.fs.exists(tablePath)) tableRaw = await $.fs.read(tablePath, { as: 'bytes' });
        const casePath = joinPath(payloadRoot, 'data/en/case-policy.json');
        if (await $.fs.exists(casePath)) casePolicyJson = asText(await $.fs.read(casePath));
      }
      let userToml: string | undefined;
      const tomlPath = joinPath(configRoot, 'murmo.toml');
      if (await $.fs.exists(tomlPath)) userToml = asText(await $.fs.read(tomlPath));
      // What `murmo plugin add` installed; checked against its signed file hashes.
      const installed = await readPluginSelection({ data: dataRoot }, async (path) =>
        (await $.fs.exists(path)) ? bytesOf(await $.fs.read(path, { as: 'bytes' })) : undefined,
      );
      await host.bootPacked({
        payloadRoot,
        integrityJson,
        ...(tableRaw === undefined ? {} : { tableRaw }),
        ...(casePolicyJson === undefined ? {} : { casePolicyJson }),
        ...(userToml === undefined ? {} : { userToml }),
        cwd,
        services,
        helperBinaries,
        tmpdir: (await $.env.get('TMPDIR')) ?? '',
        installed,
      });
    } catch (error) {
      host.adapter.notices.push(`startup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return result;
  });

  on('session.end', async (_rt, event, next) => {
    await host?.dispose();
    host = undefined;
    return next(event);
  });

  on('prompt.edit', async (_rt, event: PromptEditInput, next) => {
    const current = host;
    if (!current?.alive) return next(event);
    try {
      return await current.adapter.handleEdit(event, next);
    } catch {
      return next(event);
    }
  });

  on('prompt.change', (_rt, event: PromptChangeInput, next) => {
    if (host?.alive) host.adapter.handleChange(event);
    return next(event);
  });

  on('prompt.submit', async (_rt, event: PromptSubmitInput, next) => {
    const current = host;
    if (!current?.alive) return { drop: 'Murmo is still loading' };
    try {
      return await current.adapter.handleSubmit(event, next);
    } catch {
      return { drop: 'platform submit failed — blocked' };
    }
  });

  on('classic.PreToolUse', { timeout: CLAUDE_EVENT_TIMEOUT_MS }, onClassicPreToolUse);
  on('classic.Stop', { timeout: CLAUDE_EVENT_TIMEOUT_MS }, onClassicStop);
  on('turn.complete', onTurnComplete);

  on(
    'classic.UserPromptSubmit',
    { timeout: CLASSIC_GUARD_TIMEOUT_MS },
    async (_rt, event: ClassicSubmitInput, next) => {
      const current = host;
      if (!current?.alive) return next(event);
      try {
        return await current.adapter.handleClassic(event, next);
      } catch {
        return { block: 'final guard failed — blocked' };
      }
    },
  );

  on('prompt.autocomplete', async (_rt, event: AutocompleteInput, next) => {
    const hostRows = await next(event);
    if (!host?.alive) return hostRows;
    return host.adapter.handleAutocomplete(event, hostRows as AutocompleteResult);
  });

  on('ui.render', { component: 'PromptHint' }, async (_rt, event: RenderEvent, next) => {
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

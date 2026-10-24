// Config edited while a host session runs. Files are re-checked while idle,
// never on the key path (02-architecture § Loading and failures). Most settings
// apply live: the built-ins they configure are reloaded one by one. Settings
// that shape the session itself (event hooks, the plugin list) need a restart,
// and the host says so instead of leaving the user to guess.

import type { EffectiveConfig } from './merge.ts';

/** How often a running session re-checks its config files. One lstat per file; Claude asks its helper. */
export const RECHECK_MS = 2000;

/**
 * What each built-in reads from the merged config; a change reloads that
 * built-in alone. Draft rescue is never reloaded: its idle saves and the offer
 * on screen must outlive a config edit, and it reads `private` when it saves.
 */
const BUILTIN_SETTINGS: Readonly<Record<string, (config: EffectiveConfig) => unknown>> = {
  autocorrect: (c) => [c.autocorrect, c.language ?? null, c.protect],
  shortcuts: (c) => [c.replacements, c.overrides],
  menu: (c) => [c.replacements, c.overrides, c.historyEnabled],
  phrases: (c) => [c.phrasesLearn, c.private],
  history: (c) => [c.historyEnabled, c.private],
  names: (c) => c.names ?? null,
};

/** Settings a running session can't take, by the name the user wrote them under. */
const RESTART_SETTINGS: Readonly<Record<string, (config: EffectiveConfig) => unknown>> = {
  '[events]': (c) => [c.events, c.eventsFailOpen],
  '[plugins]': (c) => [c.pluginOrder ?? null, c.plugins],
};

function differ(read: (config: EffectiveConfig) => unknown, a: EffectiveConfig, b: EffectiveConfig): boolean {
  return JSON.stringify(read(a)) !== JSON.stringify(read(b));
}

/** The built-ins whose settings differ between two loads, in a fixed order. */
export function changedBuiltins(previous: EffectiveConfig, next: EffectiveConfig): string[] {
  return Object.entries(BUILTIN_SETTINGS)
    .filter(([, read]) => differ(read, previous, next))
    .map(([id]) => id);
}

/** Settings that differ from what the session started with and only a restart applies. */
export function restartSettings(started: EffectiveConfig, next: EffectiveConfig): string[] {
  return Object.entries(RESTART_SETTINGS)
    .filter(([, read]) => differ(read, started, next))
    .map(([name]) => name);
}

/** The notice for `restartSettings`, or none. */
export function restartNotice(settings: readonly string[]): string[] {
  return settings.length ? [`Restart the agent to apply the ${settings.join(' and ')} change.`] : [];
}

export interface ConfigWatchOptions {
  /** Default `RECHECK_MS`. */
  readonly everyMs?: number;
  /** One timer; it must not keep the host process alive (Node: `unref`). Returns its cancel. */
  readonly after: (ms: number, callback: () => void) => () => void;
  /** Re-checks the files and applies a change. A failure is dropped; the next round tries again. */
  readonly check: () => Promise<void>;
}

/**
 * Re-checks a session's config every `everyMs` until stopped. One check at a
 * time: the next round is timed from the end of the last one.
 */
export function watchConfig(options: ConfigWatchOptions): () => void {
  const everyMs = options.everyMs ?? RECHECK_MS;
  let stopped = false;
  let cancel = (): void => {};
  const round = (): void => {
    cancel = options.after(everyMs, () => {
      if (stopped) return;
      options
        .check()
        .catch(() => {})
        .then(() => {
          if (!stopped) round();
        });
    });
  };
  round();
  return () => {
    stopped = true;
    cancel();
  };
}

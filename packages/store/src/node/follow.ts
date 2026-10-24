// A running Node or Bun session (Pi, OpenCode) follows `murmo plugin`: it
// notices a new plugins.json revision, hands the selection to its session,
// and acknowledges the revision with each plugin's outcome. The CLI waits for
// those acknowledgements (`waitForRevision`) before it swaps or deletes a
// plugin's files, so it never pulls code out from under a session that still
// runs it.

import { type FSWatcher, watch } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { pluginSessionFile, pluginsManifestPath, type StoreRoots } from '../layout.ts';
import type { PluginSelection } from '../plugins.ts';
import {
  type ActivationOutcome,
  readInstalledPlugins,
  readPluginsManifest,
  SESSION_SCHEMA,
  writeSessionAck,
} from './distribution.ts';

/** How often the selection is re-read if the file watcher misses a change. */
export const SELECTION_POLL_MS = 1000;

export interface SelectionOutcome {
  readonly plugins: Readonly<Record<string, ActivationOutcome>>;
  readonly errors?: Readonly<Record<string, string>>;
}

export interface SelectionWatchOptions {
  readonly roots: StoreRoots;
  /** This session's ID; its acknowledgement file is named after it. */
  readonly sessionId: string;
  readonly host: string;
  readonly pid?: number;
  /** The revision the session started with and each plugin's state then. */
  readonly started: { readonly revision: number } & SelectionOutcome;
  /** Applies a changed selection to the session. */
  readonly apply: (selection: PluginSelection) => Promise<SelectionOutcome>;
  /** Default `SELECTION_POLL_MS`. */
  readonly pollMs?: number;
}

export interface SelectionWatch {
  /** Re-reads now; resolves once any change it found is applied and acknowledged. */
  check(): Promise<void>;
  /** Stops following and withdraws the acknowledgement, so no command waits on this session. */
  stop(): Promise<void>;
}

export async function watchPluginSelection(options: SelectionWatchOptions): Promise<SelectionWatch> {
  const { roots } = options;
  const pid = options.pid ?? process.pid;
  let revision = options.started.revision;
  let stopped = false;
  const ack = (at: number, outcome: SelectionOutcome) =>
    writeSessionAck(roots, options.sessionId, {
      schema: SESSION_SCHEMA,
      pid,
      host: options.host,
      revision: at,
      plugins: outcome.plugins,
      ...(outcome.errors && Object.keys(outcome.errors).length ? { errors: outcome.errors } : {}),
    });
  await ack(revision, options.started);

  // One check at a time; a change seen while one runs gets one more round.
  let running: Promise<void> | undefined;
  let again = false;
  const round = async (): Promise<void> => {
    const manifest = await readPluginsManifest(roots);
    if (stopped || !manifest || manifest.revision === revision) return;
    const selection = await readInstalledPlugins(roots);
    if (stopped) return;
    const outcome = await options.apply(selection);
    revision = selection.revision;
    if (!stopped) await ack(revision, outcome);
  };
  const check = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await round().catch(() => {});
      } while (again && !stopped);
      running = undefined;
    })();
    return running;
  };

  const file = pluginsManifestPath(roots);
  let watcher: FSWatcher | undefined;
  try {
    // The directory, not the file: the CLI replaces plugins.json by rename.
    watcher = watch(dirname(file), { persistent: false }, (_event, name) => {
      if (name === null || String(name) === basename(file)) void check();
    });
    watcher.on('error', () => {});
  } catch {
    watcher = undefined;
  }
  const timer = setInterval(() => void check(), options.pollMs ?? SELECTION_POLL_MS);
  timer.unref?.();

  return {
    check,
    async stop() {
      stopped = true;
      watcher?.close();
      clearInterval(timer);
      await running;
      await rm(pluginSessionFile(roots, options.sessionId), { force: true });
    },
  };
}

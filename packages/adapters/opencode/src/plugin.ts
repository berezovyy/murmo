import { OpenCodeAdapter } from './adapter.ts';
import { type SessionStartOptions, type StartedSession, startSession } from './session.ts';
import { createStatusSurface } from './status.ts';
import type { OpenCodeApi, OpenTuiCore } from './types.ts';

export interface TuiSetupOptions extends Omit<SessionStartOptions, 'adapter'> {
  readonly hostVersion?: string;
}

export interface TuiHandle {
  readonly adapter: OpenCodeAdapter;
  /** The running session once OpenCode's prompt has focus; `undefined` if closed first or it failed to start. */
  readonly session: Promise<StartedSession | undefined>;
  dispose(): Promise<void>;
}

/**
 * Testable TUI setup: inject OpenTUI constructors. The `/tui` entry calls this.
 *
 * OpenCode mounts its prompt only after every plugin's setup has returned, so
 * setup must not wait for it. The status slot is claimed now; the session
 * starts when the prompt first has focus, so plugins activate and the startup
 * notices draw against a prompt that exists.
 */
export async function createTuiPlugin(
  api: OpenCodeApi,
  core: OpenTuiCore,
  options: TuiSetupOptions = {},
): Promise<TuiHandle> {
  const status = createStatusSurface(api, core);
  const adapter = new OpenCodeAdapter({
    api,
    core,
    status,
    ...(options.hostVersion ? { hostVersion: options.hostVersion } : {}),
  });
  let closed = false;
  let starting: Promise<StartedSession | undefined> | undefined;
  const start = async (): Promise<StartedSession | undefined> => {
    try {
      const started = await startSession({ ...options, adapter });
      adapter.attach();
      return started;
    } catch (error) {
      // Setup has returned, so OpenCode can no longer report this: say it in
      // Murmo's status and let every key through to OpenCode.
      adapter.dispose();
      status.set(`Murmo failed to start: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };
  const session = adapter.whenPrompt().then((focused) => {
    if (!focused || closed) return undefined;
    starting = start();
    return starting;
  });
  return {
    adapter,
    session,
    async dispose() {
      closed = true;
      const started = await starting;
      await started?.close();
      // Also ends a wait for the prompt that never came.
      adapter.dispose();
      status.dispose();
    },
  };
}

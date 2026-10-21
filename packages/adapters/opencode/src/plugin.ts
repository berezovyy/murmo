import { OpenCodeAdapter } from './adapter.ts';
import { type SessionStartOptions, startSession } from './session.ts';
import { createStatusSurface } from './status.ts';
import type { OpenCodeApi, OpenTuiCore } from './types.ts';

export interface TuiSetupOptions extends Omit<SessionStartOptions, 'adapter'> {
  readonly hostVersion?: string;
}

export interface TuiHandle {
  readonly adapter: OpenCodeAdapter;
  dispose(): Promise<void>;
}

/** Testable TUI setup: inject OpenTUI constructors. The `/tui` entry calls this. */
export async function createTuiPlugin(
  api: OpenCodeApi,
  core: OpenTuiCore,
  options: TuiSetupOptions = {},
): Promise<TuiHandle> {
  const status = createStatusSurface(api);
  const adapter = new OpenCodeAdapter({
    api,
    core,
    status,
    ...(options.hostVersion ? { hostVersion: options.hostVersion } : {}),
  });
  const started = await startSession({ ...options, adapter });
  adapter.attach();
  return {
    adapter,
    async dispose() {
      await started.close();
      adapter.dispose();
      status.dispose();
    },
  };
}

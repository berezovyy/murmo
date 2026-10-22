// Plugin settings: learning is opt-in. A project file can only turn it off
// (phase 14 already drops `learn = true` from `.murmo.toml`).

export interface PhrasesSettings {
  /** Default false: nothing is learned until `[phrases] learn = true`. */
  readonly learn: boolean;
  /**
   * Host-level ghost switch. Codex stays off unless this is true *and* the
   * adapter has turned the route on; Claude uses menu rows when Tab is invisible.
   */
  readonly ghost: boolean;
  /** Default true: no ghost while `HostState.busy`. */
  readonly skipWhenBusy: boolean;
}

export function resolvePhrasesSettings(input: Readonly<Record<string, unknown>> = {}): PhrasesSettings {
  return {
    learn: input.learn === true,
    ghost: input.ghost !== false,
    skipWhenBusy: input.skipWhenBusy !== false,
  };
}

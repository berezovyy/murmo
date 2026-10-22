// History is opt-in. A project file can only turn it off.

export interface HistorySettings {
  /** Default false: nothing is recorded or searched until `[history] enabled = true`. */
  readonly enabled: boolean;
}

export function resolveHistorySettings(input: Readonly<Record<string, unknown>> = {}): HistorySettings {
  return { enabled: input.enabled === true };
}

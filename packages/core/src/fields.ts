// Cached field-session ranges. The key router reads this; plugin code does not
// run on the key path (lesson 46, phase 37 `in-my-field-session`).

import type { Range } from '@murmo/api';

export interface FieldSession {
  readonly ranges: readonly Range[];
  readonly active: number;
  readonly version: number;
}

export class FieldSessions {
  readonly #map = new Map<string, FieldSession>();

  set(pluginId: string, ranges: readonly Range[] | null, version: number, active = 0): void {
    if (!ranges || ranges.length === 0) {
      this.#map.delete(pluginId);
      return;
    }
    this.#map.set(pluginId, { ranges: ranges.map((r) => [r[0], r[1]] as Range), active, version });
  }

  of(pluginId: string): FieldSession | undefined {
    return this.#map.get(pluginId);
  }

  /** First-field start through last-field end, or null. */
  envelope(pluginId: string): Range | null {
    const session = this.#map.get(pluginId);
    if (!session) return null;
    const first = session.ranges[0];
    const last = session.ranges[session.ranges.length - 1];
    if (!first || !last) return null;
    return [first[0], last[1]];
  }

  /** True when this plugin's session is active and `cursor` is inside the envelope. */
  contains(pluginId: string, cursor: number): boolean {
    const envelope = this.envelope(pluginId);
    if (!envelope) return false;
    return cursor >= envelope[0] && cursor <= envelope[1];
  }

  /** Every live field range, for skipping shortcut re-expansion inside values. */
  frozen(): Range[] {
    const out: Range[] = [];
    for (const session of this.#map.values()) out.push(...session.ranges);
    return out;
  }

  clear(pluginId?: string): void {
    if (pluginId) this.#map.delete(pluginId);
    else this.#map.clear();
  }
}

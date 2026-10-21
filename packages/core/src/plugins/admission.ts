// Load admission: source, assets and requested guest memory. The in-process
// executor records the cap (`hardLimits: false`) but cannot enforce RSS; the
// isolated helper (phase 10) does. A 30 MiB guest needs a reviewed ceiling
// above the 8 MiB default (r14 L4, E5).

import { LIMITS } from '@murmo/api';
import type { PluginSpec } from '@murmo/api/adapter';
import { utf8Length } from '@murmo/text';

export interface Admission {
  readonly memoryMiB: number;
}

export interface AdmissionLimits {
  readonly maxMemoryMiB?: number;
}

export function admit(spec: PluginSpec, limits: AdmissionLimits = {}): Admission {
  const source = spec.source;
  if (typeof source === 'string' && utf8Length(source) > LIMITS.sourceBytes) {
    throw new Error(`plugin source exceeds ${LIMITS.sourceBytes} bytes`);
  }
  let assets = 0;
  if (spec.assets) {
    for (const buffer of Object.values(spec.assets)) assets += buffer.byteLength;
    if (assets > LIMITS.assetBytes) throw new Error(`plugin assets exceed ${LIMITS.assetBytes} bytes`);
  }
  const requested = spec.resources?.memoryMiB ?? spec.manifest?.resources?.memoryMiB ?? LIMITS.defaultMemoryMiB;
  const max = limits.maxMemoryMiB ?? LIMITS.defaultMemoryMiB;
  if (requested > max) {
    throw Object.assign(new Error(`memory admission denied: ${requested} MiB requested, max ${max} MiB`), {
      code: 'memory',
    });
  }
  return { memoryMiB: requested };
}

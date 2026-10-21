import type { Capabilities } from '@murmo/api';
import { ManifestError, negotiate, type PluginManifest } from '@murmo/api';
import type { HostCapabilities } from '@murmo/api/adapter';

export interface CapabilityCase {
  readonly path: string;
  readonly required: boolean;
  readonly outcome: 'refused' | 'declared-degradation';
  proof?: string;
  status?: string | null;
}

function setPath(caps: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let object: Record<string, unknown> = caps;
  for (const key of parts.slice(0, -1)) {
    const next = object[key];
    if (!next || typeof next !== 'object') object[key] = {};
    object = object[key] as Record<string, unknown>;
  }
  object[parts.at(-1) as string] = value;
}

export const missingValue = (value: unknown): unknown =>
  typeof value === 'boolean' ? !value : Array.isArray(value) ? [] : '__missing__';

export function cloneCaps(caps: HostCapabilities | Capabilities): HostCapabilities {
  return JSON.parse(JSON.stringify(caps)) as HostCapabilities;
}

/** One case per declared missing required capability (refuse) and optional one (degrade). */
export function capabilityCases(manifest: PluginManifest, caps: HostCapabilities | Capabilities): CapabilityCase[] {
  const results: CapabilityCase[] = [];
  for (const [path, value] of Object.entries(manifest.capabilities.required)) {
    if (path.startsWith('api.')) {
      try {
        negotiate(manifest, caps as Capabilities, '1.2.0');
        throw new Error(`expected API refuse for ${path}`);
      } catch (error) {
        if (!(error instanceof ManifestError)) throw error;
      }
    } else {
      const degraded = cloneCaps(caps);
      setPath(degraded as unknown as Record<string, unknown>, path, missingValue(value));
      if (Array.isArray(value) && !value.length) continue;
      try {
        negotiate(manifest, degraded as Capabilities);
        throw new Error(`expected refuse for ${path}`);
      } catch (error) {
        if (!(error instanceof ManifestError) || error.code !== 'capability-unavailable') throw error;
      }
    }
    results.push({ path, required: true, outcome: 'refused' });
  }
  for (const [path, value] of Object.entries(manifest.capabilities.optional)) {
    if (Array.isArray(value) && !value.length) continue;
    if (path.startsWith('api.')) {
      results.push({ path, required: false, outcome: 'declared-degradation' });
      continue;
    }
    const optionalOnly: PluginManifest = {
      ...manifest,
      capabilities: { required: {}, optional: { [path]: value } },
    };
    const degraded = cloneCaps(caps);
    setPath(degraded as unknown as Record<string, unknown>, path, missingValue(value));
    const result = negotiate(optionalOnly, degraded as Capabilities);
    if (result.optional[path] !== false) throw new Error(`optional ${path} did not degrade`);
    results.push({ path, required: false, outcome: 'declared-degradation' });
  }
  return results;
}

export { setPath };

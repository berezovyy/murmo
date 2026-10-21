// Submit-pipeline constants and the permission/fault seam phase 09 replaces.

import type { Permission } from '@murmo/api';
import { DEADLINES, LIMITS } from '@murmo/api';
import type { PluginEntry } from '../hooks.ts';

/** Unscaled total for every `onBeforeSubmit` of one attempt (E8, E9). */
export const SUBMIT_DEADLINE_MS = DEADLINES.submitTotalMs;

/** Target: forward until clear or this elapses, then `unknown` (E17, E18). */
export const COMMIT_WINDOW_MS = 2_000;

/** Duplicate `submissionId`s among the last this many are dropped (E8). */
export const COMMITTED_DEDUP = 256;

/** Per-observer committed/unresolved queue; overflow drops the oldest (E12). */
export const OBSERVER_QUEUE = 32;

/**
 * Total deadline for one attempt. Pressure scaling is off until phase 29
 * measures host submit-hook limits (lesson 76); the flag is the seam.
 */
export function submitDeadlineMs(options: { scaleByPressure?: boolean; pressure?: number }): number {
  if (!options.scaleByPressure) return SUBMIT_DEADLINE_MS;
  const raw = options.pressure ?? 1;
  const pressure = Number.isFinite(raw) ? Math.min(LIMITS.budgetScaleMax, Math.max(1, Math.floor(raw))) : 1;
  return SUBMIT_DEADLINE_MS * pressure;
}

/**
 * Permission answers the pipeline needs. Phase 05/08 treat declared
 * permissions as granted (as the prototype did); phase 09 substitutes grants.
 */
export interface SubmitAccess {
  maySubmit(plugin: PluginEntry): boolean;
  mayObserve(plugin: PluginEntry): boolean;
  mayReadFull(plugin: PluginEntry): boolean;
  holds(plugin: PluginEntry, permission: Permission): boolean;
}

export function declaredAccess(): SubmitAccess {
  const has = (plugin: PluginEntry, permission: Permission): boolean => {
    if (permission === 'draft:read' && plugin.permissions.includes('draft:read:full')) return true;
    return plugin.permissions.includes(permission);
  };
  return {
    maySubmit: (plugin) => has(plugin, 'submit') && plugin.hooks.has('onBeforeSubmit'),
    mayObserve: (plugin) => has(plugin, 'submit:observe'),
    mayReadFull: (plugin) => has(plugin, 'draft:read:full'),
    holds: has,
  };
}

export interface SubmitDecisionCounts {
  send: number;
  block: number;
  replace: number;
}

export function emptyDecisions(): SubmitDecisionCounts {
  return { send: 0, block: 0, replace: 0 };
}

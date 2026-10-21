// Grant evaluation. A declaration is never a grant: PERMISSION_DEFAULTS from
// @murmo/api/adapter decide what a declared permission becomes, and an explicit
// map (phase 28 writes it) can add `explicit`/`builtin` permissions. `network`
// still opens no route.

import type { Permission } from '@murmo/api';
import { PERMISSION_DEFAULTS, routesFor } from '@murmo/api/adapter';
import type { PluginEntry } from '../hooks.ts';
import type { SubmitAccess } from '../submit/types.ts';

export type GrantMap = Readonly<Record<string, readonly Permission[]>>;

export interface GrantSubject {
  readonly id: string;
  readonly builtin: boolean;
  readonly declared: readonly Permission[];
}

function declaredSet(declared: readonly Permission[]): Set<Permission> {
  const held = new Set<Permission>(declared);
  if (held.has('draft:read:full')) held.add('draft:read');
  return held;
}

function listed(list: readonly Permission[] | undefined, permission: Permission): boolean {
  if (!list) return false;
  if (list.includes(permission)) return true;
  return permission === 'draft:read' && list.includes('draft:read:full');
}

/** Whether this plugin holds `permission` after defaults and the host grant map. */
export function isGranted(plugin: GrantSubject, permission: Permission, grants?: GrantMap): boolean {
  if (!declaredSet(plugin.declared).has(permission)) return false;
  if (listed(grants?.[plugin.id], permission)) return true;
  const fallback = PERMISSION_DEFAULTS[permission];
  if (fallback === 'declared') return true;
  if (fallback === 'builtin') return plugin.builtin;
  return false;
}

export function grantedPermissions(plugin: GrantSubject, grants?: GrantMap): Permission[] {
  return plugin.declared.filter((permission) => isGranted(plugin, permission, grants));
}

export function grantAccess(grants?: GrantMap): SubmitAccess {
  const has = (plugin: PluginEntry, permission: Permission): boolean =>
    isGranted({ id: plugin.id, builtin: plugin.builtin, declared: plugin.permissions }, permission, grants);
  return {
    maySubmit: (plugin) => has(plugin, 'submit') && plugin.hooks.has('onBeforeSubmit'),
    mayObserve: (plugin) => has(plugin, 'submit:observe'),
    mayReadFull: (plugin) => has(plugin, 'draft:read:full'),
    holds: has,
  };
}

/** Routes a granted set opens; used after substituting grants for declarations. */
export function grantedRoutes(granted: readonly Permission[]) {
  return routesFor(granted);
}

// Type tests: compiled by `pnpm check`, never run. Each `@ts-expect-error` line
// must fail to compile; if the API stops rejecting it, tsc reports the unused
// directive and the check fails.

import type { Effect, KeyClaim, MenuItem, Plugin, PluginManifest } from '@murmo/api';
import type { HookRoute, PluginSpec } from '@murmo/api/adapter';
import { HOOKS } from '@murmo/api/adapter';
import type { CAPABILITY_PATHS, CapabilityPath } from '../src/caps.ts';
import type { HookNames } from '../src/plugin.ts';

const manifest: PluginManifest = {
  name: 'example',
  version: '1.0.0',
  api: '^2.0.0',
  entry: 'plugin.mjs',
  permissions: [{ name: 'draft:read', reason: 'Count characters.' }],
  capabilities: { required: {}, optional: {} },
  settingsSchema: { type: 'object', properties: {} },
};

// A third-party manifest can't claim built-in trust (E2): there is no such field.
// @ts-expect-error builtin is not a manifest field
export const selfDeclaredBuiltin: PluginManifest = { ...manifest, builtin: true };

// Only the host marks a spec built-in; every other spec carries a manifest, so
// preflight always runs before third-party code.
export const builtinSpec: PluginSpec = { id: 'autocorrect', builtin: true, source: '' };
export const thirdPartySpec: PluginSpec = { id: 'lint', manifest, source: '' };
// @ts-expect-error a non-built-in spec without a manifest
export const manifestless: PluginSpec = { id: 'lint', source: '' };
// @ts-expect-error inline rule sets are registered for built-ins only
export const thirdPartyInline: PluginSpec = { id: 'lint', manifest, inline: [] };

// An `always` claim on a shared key type-checks; the core refuses it at load for
// third-party plugins (documented in api.md § Keys). The type can't know trust.
export const alwaysTab: KeyClaim = { key: 'Tab', when: ['always'], action: 'consume' };
// @ts-expect-error `consume: true` only qualifies a dispatch claim
export const consumeTwice: KeyClaim = { key: 'F8', when: ['editable'], action: 'consume', consume: true };

// Every effect is bound to a version: a result computed for an old draft must be
// droppable as stale (author clarification 10).
// @ts-expect-error status without baseVersion
export const unboundStatus: Effect = { type: 'status', text: 'hi' };
// @ts-expect-error edit without baseVersion
export const unboundEdit: Effect = { type: 'edit', edit: { from: 0, to: 0, insert: 'x' } };

// The menu owner is host-owned (cleanup: one `owner`, set by the core).
// @ts-expect-error a plugin cannot name the owner of its row
export const spoofedOwner: MenuItem = { id: 'a', label: 'A', owner: 'other-plugin' };

// The hook table covers every hook. A hook added to `Plugin` but not to `HOOKS`
// would be a route the helper parity gate never checks (lesson 73); planted here.
type ExtendedPlugin = Plugin & { onFutureEvent?(event: unknown): void };
export const hooksCoverPlugin: { readonly [K in HookNames<Plugin>]: HookRoute } = HOOKS;
// @ts-expect-error HOOKS lacks the planted onFutureEvent hook
export const hooksCoverExtended: { readonly [K in HookNames<ExtendedPlugin>]: HookRoute } = HOOKS;

// CAPABILITY_PATHS lists every capability path, so negotiation never calls a
// real capability "unknown".
type MissingPath = Exclude<CapabilityPath, (typeof CAPABILITY_PATHS)[number]>;
export const capabilityPathsComplete: [MissingPath] extends [never] ? true : MissingPath = true;

// Adapter-side types are not on the author entry point.
// @ts-expect-error Adapter is exported from @murmo/api/adapter only
export type AuthorSeesAdapter = import('@murmo/api').Adapter;

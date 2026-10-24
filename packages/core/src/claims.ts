// Key-claim validation at load. Claims are data: a function predicate, an
// unknown condition, or a write that the host cannot intercept is refused
// here, with a notice, and that claim is dropped. The plugin stays loaded
// (lesson 46: no plugin code on the key path).

import { isCanonicalKey, KEY_CONDITIONS, type KeyClaim, type KeyCondition, type KeyId, SHARED_KEYS } from '@murmo/api';
import type { HostCapabilities } from '@murmo/api/adapter';

const conditions: ReadonlySet<string> = new Set(KEY_CONDITIONS);
const shared: ReadonlySet<string> = new Set(SHARED_KEYS);

export interface ValidatedClaim {
  readonly key: KeyId;
  readonly when: readonly KeyCondition[];
  readonly action: 'accept-ghost' | 'consume' | 'dispatch';
  /** True for `accept-ghost`, `consume`, and `dispatch` with `consume: true`. */
  readonly consume: boolean;
}

export interface ClaimValidation {
  readonly claims: readonly ValidatedClaim[];
  readonly notices: readonly string[];
}

export function isSharedKey(key: KeyId): boolean {
  return shared.has(key);
}

/** A claim that inserts or swallows a key. `dispatch` without consume does not write. */
export function claimWrites(claim: ValidatedClaim): boolean {
  return claim.consume || claim.action === 'accept-ghost';
}

function notice(plugin: string, index: number, reason: string): string {
  return `${plugin}: key claim ${index + 1} refused: ${reason}`;
}

function asClaim(value: unknown): KeyClaim | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as { key?: unknown; when?: unknown; action?: unknown; consume?: unknown };
  if (typeof c.key !== 'string' || typeof c.action !== 'string') return null;
  if (!Array.isArray(c.when) || c.when.some((item) => typeof item !== 'string')) return null;
  if (c.action !== 'accept-ghost' && c.action !== 'consume' && c.action !== 'dispatch') return null;
  if (c.action === 'dispatch') {
    return {
      key: c.key,
      when: c.when as KeyCondition[],
      action: 'dispatch',
      ...(c.consume === true ? { consume: true } : {}),
    };
  }
  return { key: c.key, when: c.when as KeyCondition[], action: c.action };
}

/**
 * Validates `declared` once at load. Refused claims are omitted; the plugin is
 * not disabled. Built-ins follow the same shared-key `always` rule as
 * third-party plugins, so our own plugins cannot starve the host either.
 */
export function validateClaims(
  plugin: { readonly id: string; readonly name: string; readonly builtin: boolean },
  declared: unknown,
  caps: HostCapabilities,
): ClaimValidation {
  const notices: string[] = [];
  if (declared === undefined || declared === null) return { claims: [], notices };
  if (!Array.isArray(declared)) {
    notices.push(`${plugin.name}: key claims refused: claims must be data, not a function`);
    return { claims: [], notices };
  }
  const claims: ValidatedClaim[] = [];
  for (let i = 0; i < declared.length; i++) {
    const raw = declared[i];
    if (typeof raw === 'function') {
      notices.push(notice(plugin.name, i, 'function predicates are not claims'));
      continue;
    }
    const claim = asClaim(raw);
    if (!claim) {
      notices.push(notice(plugin.name, i, 'claim is not data with key, when and action'));
      continue;
    }
    if (!isCanonicalKey(claim.key)) {
      notices.push(notice(plugin.name, i, `key ${JSON.stringify(claim.key)} is not a canonical ID`));
      continue;
    }
    if (claim.when.length === 0) {
      notices.push(notice(plugin.name, i, 'when must list at least one condition'));
      continue;
    }
    const unknown = claim.when.find((c) => !conditions.has(c));
    if (unknown) {
      notices.push(notice(plugin.name, i, `unknown condition ${JSON.stringify(unknown)}`));
      continue;
    }
    const consume = claim.action !== 'dispatch' || claim.consume === true;
    if (claim.key === 'Enter' && consume) {
      notices.push(notice(plugin.name, i, 'Enter is never consumed by a claim'));
      continue;
    }
    if (consume && claim.when.includes('always') && isSharedKey(claim.key)) {
      notices.push(
        notice(
          plugin.name,
          i,
          `always consumption of shared key ${claim.key} is refused${plugin.builtin ? ' (built-in)' : ''}`,
        ),
      );
      continue;
    }
    if (consume && claim.action !== 'dispatch' && !caps.keys.includes(claim.key)) {
      // A host that cannot take a key is a known gap (Claude has no Tab):
      // the user can't act on it, so a built-in's dropped claim stays quiet.
      if (!plugin.builtin) notices.push(notice(plugin.name, i, `host cannot intercept ${claim.key}`));
      continue;
    }
    claims.push({ key: claim.key, when: claim.when, action: claim.action, consume });
  }
  return { claims, notices };
}

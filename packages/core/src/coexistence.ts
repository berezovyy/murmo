// Phase 25: named coexistence boundaries, one notice per boundary per session,
// and the doctor data feed. Detection names its evidence; unknown is valid;
// a bare listener index is not a conflict (r14-ecosystem C4, E7).

import type { CapabilityRequirement, CoexistenceCapabilities, HostName, HostState } from '@murmo/api';
import type { HostCapabilities } from '@murmo/api/adapter';
import type { LoadedPlugin } from './hooks.ts';

/** The eight boundaries in docs/plan/25. */
export type BoundaryId =
  | 'exclusive-editor'
  | 'unsafe-callback'
  | 'native-ui'
  | 'listener-precedes'
  | 'outer-binding'
  | 'raw-injection'
  | 'guard-coverage'
  | 'missing-hook';

/** Documented defaults (compose, defer, suppress, refuse, block). */
export type BoundaryAction = 'compose' | 'defer' | 'suppress' | 'refuse' | 'block';

export type EvidenceKind =
  | 'factory-identity'
  | 'accessor-descriptor'
  | 'listener-order'
  | 'measured-capability'
  | 'peer-declaration'
  | 'witness-key'
  | 'environment'
  | 'undetectable';

export interface BoundaryPeer {
  readonly id: string;
  readonly version: string;
}

export interface BoundaryEvidence {
  readonly kind: EvidenceKind;
  /** Listener index is not proof a peer steals a given key (E7). */
  readonly index?: number;
  readonly count?: number;
  readonly at?: string;
  readonly multiplexer?: string;
  readonly key?: string;
  readonly configurable?: boolean;
  readonly accessor?: boolean;
  readonly detail?: string;
}

export interface BoundaryRecord {
  readonly boundary: BoundaryId;
  readonly evidence: BoundaryEvidence;
  readonly action: BoundaryAction;
  readonly peer?: BoundaryPeer;
}

const BOUNDARY_ORDER: readonly BoundaryId[] = [
  'exclusive-editor',
  'unsafe-callback',
  'native-ui',
  'listener-precedes',
  'outer-binding',
  'raw-injection',
  'guard-coverage',
  'missing-hook',
];

export const FINAL_GUARD_UNAVAILABLE = 'final guard boundary unavailable';

export function noticeFor(record: BoundaryRecord): string {
  switch (record.boundary) {
    case 'exclusive-editor':
      return 'Murmo: another editor owns the prompt. Editor features are off; pick one editor. (ownership-lost)';
    case 'unsafe-callback':
      return record.action === 'refuse'
        ? 'Murmo: cannot wrap onChange/onSubmit (non-configurable accessor). Composition refused.'
        : 'Murmo: installed a data-property wrap so a peer accessor cannot recurse.';
    case 'native-ui':
      return 'Murmo: host menu or dialog is open; ghost accept and edits are deferred until it closes.';
    case 'listener-precedes':
      return 'Murmo: another listener precedes us; key priority is unknown. Run murmo.prioritize for this session (a later peer can retake it).';
    case 'outer-binding':
      return record.evidence.kind === 'witness-key'
        ? 'Murmo: Tab or F6 did not arrive (outer terminal binding). Move it behind the multiplexer prefix, or rebind Murmo accept/undo.'
        : 'Murmo: running inside a multiplexer; outer Tab/F6 bindings are unknown. Prefix-bind those keys or rebind Murmo accept/undo.';
    case 'raw-injection':
      return 'Murmo: origin is not guaranteed for raw injected text. Use bracketed paste (tmux paste-buffer -p) or an origin-tagged insertion.';
    case 'guard-coverage':
      return record.action === 'block'
        ? FINAL_GUARD_UNAVAILABLE
        : 'Murmo: this host covers Murmo plugins only (managed). A later native peer can still change the prompt.';
    case 'missing-hook':
      return record.evidence.detail
        ? `Murmo: required runtime hook unavailable; dependent feature disabled (${record.evidence.detail}).`
        : 'Murmo: required runtime hook unavailable; dependent feature disabled.';
  }
}

/** One doctor data line; never draft text. Phase 27 prints these. */
export function doctorLine(record: BoundaryRecord): string {
  const peer = record.peer ? ` peer=${record.peer.id}@${record.peer.version}` : '';
  return `coexist ${record.boundary} ${record.action} ${record.evidence.kind}${peer}`;
}

export function doctorLines(records: readonly BoundaryRecord[]): readonly string[] {
  return records.map(doctorLine);
}

/**
 * One record per boundary per session. A second detection of the same boundary
 * is kept for diagnostics but does not emit another notice.
 */
export class BoundaryBook {
  readonly #records: BoundaryRecord[] = [];
  readonly #seen = new Set<BoundaryId>();

  get records(): readonly BoundaryRecord[] {
    return this.#records;
  }

  get(boundary: BoundaryId): BoundaryRecord | undefined {
    return this.#records.find((row) => row.boundary === boundary);
  }

  /** Returns the notice to show, or undefined when this boundary already notified. */
  record(entry: BoundaryRecord): string | undefined {
    const previous = this.get(entry.boundary);
    this.#records.push(entry);
    if (!this.#seen.has(entry.boundary)) {
      this.#seen.add(entry.boundary);
      return noticeFor(entry);
    }
    // A missed witness key is stronger than "$TMUX is set" and is the actionable notice.
    if (
      entry.boundary === 'outer-binding' &&
      entry.evidence.kind === 'witness-key' &&
      previous?.evidence.kind === 'environment'
    ) {
      return noticeFor(entry);
    }
    return undefined;
  }

  doctorLines(): readonly string[] {
    const first = new Map<BoundaryId, BoundaryRecord>();
    for (const row of this.#records) if (!first.has(row.boundary)) first.set(row.boundary, row);
    return BOUNDARY_ORDER.flatMap((id) => {
      const row = first.get(id);
      return row ? [doctorLine(row)] : [];
    });
  }
}

export function wantsFinalBoundary(required: CapabilityRequirement | undefined): boolean {
  return required === 'final-boundary' || (Array.isArray(required) && required.includes('final-boundary'));
}

export interface GuardCoverage {
  readonly policy: 'managed' | 'final-boundary';
  readonly block: boolean;
  readonly records: readonly BoundaryRecord[];
}

/**
 * A requiredGuard that demands `submit.guardPosition: final-boundary` on a
 * managed adapter refuses the guarantee and blocks send (E9, E14). A
 * non-required (optional) miss is a notice only.
 */
export function inspectGuardCoverage(loaded: readonly LoadedPlugin[], caps: HostCapabilities): GuardCoverage {
  const records: BoundaryRecord[] = [];
  let block = false;
  const managed = caps.submit.guardPosition !== 'final-boundary';
  for (const plugin of loaded) {
    const required = plugin.requiredCapabilities?.['submit.guardPosition'];
    if (wantsFinalBoundary(required) && managed && (plugin.requiredGuard === true || plugin.descriptor.guard)) {
      block = true;
      records.push({
        boundary: 'guard-coverage',
        evidence: { kind: 'measured-capability', detail: plugin.descriptor.id },
        action: 'block',
      });
    } else if (plugin.missingOptional?.includes('submit.guardPosition') && managed) {
      records.push({
        boundary: 'guard-coverage',
        evidence: { kind: 'measured-capability', detail: plugin.descriptor.id },
        action: 'compose',
      });
    }
  }
  return { policy: block ? 'final-boundary' : 'managed', block, records };
}

export function nativeUiOpen(state: HostState): boolean {
  return state.popup !== null || state.dialog;
}

const HOST_DEFAULTS: { readonly [K in HostName]: CoexistenceCapabilities } = {
  fake: { editorComposition: 'chainable', keyArbitration: 'host-coordinated', peerUiObservable: true },
  claude: { editorComposition: 'chainable', keyArbitration: 'host-coordinated', peerUiObservable: true },
  opencode: { editorComposition: 'unknown', keyArbitration: 'unknown', peerUiObservable: false },
  pi: { editorComposition: 'unknown', keyArbitration: 'unknown', peerUiObservable: false },
  codex: { editorComposition: 'unknown', keyArbitration: 'murmo-only', peerUiObservable: false },
};

/** Per-host starting values; a session measurement overwrites fields. */
export function coexistenceFor(
  host: HostName,
  measured: Partial<CoexistenceCapabilities> = {},
): CoexistenceCapabilities {
  return { ...HOST_DEFAULTS[host], ...measured };
}

/** Duck-typed adapter book so the Adapter interface stays unchanged (03). */
export function bookOf(adapter: object, fallback: BoundaryBook): BoundaryBook {
  const extra = adapter as { readonly boundaries?: BoundaryBook };
  return extra.boundaries instanceof BoundaryBook ? extra.boundaries : fallback;
}

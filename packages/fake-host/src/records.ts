// Capability records the profiles are generated from. Claude's row is the
// phase-24 adapter (not historical). Other hosts stay on round-13/14 seeds
// until their adapters emit a fresh record. A record never claims 2.0-pre
// guarantees no real adapter has shown (`edit.attributed`, `dialogSafe`,
// `submit.committed` as accepted-text).

import type { HostName } from '@murmo/api';
import type { CapsPatch } from './adapter.ts';

export type FakeHostProfile = Exclude<HostName, 'fake'>;

export type HostQuirk =
  | 'keyless-bursts-have-unknown-origin'
  | 'paste-unknown-origin'
  | 'no-async-CAS'
  | 'partial-key-observation'
  | 'menu-enter-dismisses-via-submit-boundary'
  | 'Tab-queues'
  | 'tracked-draft'
  | 'managed-submit-boundary'
  | 'native-popup-tab-passes'
  | 'packet-paste-after-following-typing'
  | 'dialog-unobservable'
  | 'footer-status'
  | 'one-editor-slot'
  | 'opaque-paste-uneditable';

export interface CapabilityRecord {
  readonly host: FakeHostProfile;
  readonly version: string;
  /** ISO date the measurement was taken. */
  readonly measuredAt: string;
  readonly report: string;
  /** True until a real adapter (21–24) emits a fresh record. */
  readonly historical: boolean;
  readonly quirks: readonly HostQuirk[];
  readonly patch: CapsPatch;
}

/** Historical 2.0-pre floor: nothing a real adapter has not shown. */
export function historicalFloor(): CapsPatch {
  return {
    edit: { attributed: false },
    inline: { attributed: false },
    ui: { dialogSafe: false, opaqueParts: true },
    submit: { committed: 'none', guardPosition: 'managed' },
    keyPriority: 'unknown',
    semanticMenuSelection: false,
    actions: [],
  };
}

/**
 * Round 13/14 seed, independently selected with `--profile`. Names, versions
 * and source reports match `experiments/platform/shared-v2/fake-adapter/host-profiles.ts`.
 */
export const SEED_RECORDS: readonly CapabilityRecord[] = [
  {
    host: 'claude',
    version: '2.1.304',
    measuredAt: '2026-10-21',
    report: 'docs/plan/24-adapter-claude-code.md',
    historical: false,
    quirks: [
      'keyless-bursts-have-unknown-origin',
      'paste-unknown-origin',
      'no-async-CAS',
      'partial-key-observation',
      'menu-enter-dismisses-via-submit-boundary',
    ],
    patch: {
      inputOriginEvidence: 'host-labeled',
      inlineRewrite: 'same-transaction',
      edit: {
        atomic: false,
        end: true,
        middle: false,
        multiline: true,
        selection: false,
        exactRestore: false,
        certainties: ['authoritative'],
      },
      ghost: 'end-only',
      highlight: 'none',
      undoKeys: [],
      inline: {
        allKeysObserved: false,
        nativeCompletion: true,
        commitReceipt: 'read-back',
        maxBytes: 1024,
        middle: true,
        multiline: true,
      },
      keys: [],
      submit: { gestures: ['send', 'queue'], guardPosition: 'managed', committed: 'none' },
      ui: { anchor: 'host-owned', normalization: 'NFC', dialogSafe: false, opaqueParts: false, statusMaxLength: 80 },
    },
  },
  {
    host: 'codex',
    version: '0.163.0',
    measuredAt: '2026-10-13',
    report: 'docs/experiments/r13-codex-inline.md',
    historical: true,
    quirks: ['Tab-queues', 'tracked-draft', 'managed-submit-boundary', 'native-popup-tab-passes'],
    patch: {
      // The Codex wrapper labels keys (r13); observed-unmarked is the stock CLI
      // without a wrapper (E8). Phase 23 advertises the product wrapper: 800-byte
      // transport cap, managed PTY rewrite, menu/ghost off until prompt detection.
      inputOriginEvidence: 'host-labeled',
      inlineRewrite: 'immediate-managed-transport',
      edit: { selection: false, certainties: ['tracked'] },
      ghost: 'none',
      menu: false,
      highlight: 'none',
      keyPriority: 'before-peers',
      inline: { commitReceipt: 'transport-write', maxBytes: 800, nativeCompletion: false, attributed: false },
      submit: { gestures: ['send', 'queue', 'newline'], guardPosition: 'managed', committed: 'none' },
      ui: { anchor: 'overlay', statusMaxLength: 99, normalization: 'preserve', opaqueParts: true, dialogSafe: false },
    },
  },
  {
    host: 'opencode',
    version: '2.1.0',
    measuredAt: '2026-10-13',
    report: 'docs/experiments/r13-opencode-inline.md',
    historical: true,
    quirks: ['packet-paste-after-following-typing', 'managed-submit-boundary', 'dialog-unobservable', 'footer-status'],
    patch: {
      submit: { gestures: ['send', 'queue', 'newline'], guardPosition: 'managed', committed: 'none' },
      undoKeys: ['Undo'],
      ui: {
        anchor: 'overlay',
        statusMaxLength: 512,
        normalization: 'preserve',
        opaqueParts: true,
        dialogSafe: false,
        namespace: 'murmo-platform',
      },
    },
  },
  {
    host: 'pi',
    version: '1.3.0',
    measuredAt: '2026-10-13',
    report: 'docs/experiments/r13-pi-inline.md',
    historical: true,
    quirks: ['one-editor-slot', 'opaque-paste-uneditable', 'managed-submit-boundary'],
    patch: {
      edit: { selection: false },
      ghost: 'end-only',
      highlight: 'visible-row',
      undoKeys: ['Undo', 'F6'],
      submit: { gestures: ['send', 'queue', 'steer'], guardPosition: 'managed', committed: 'none' },
    },
  },
];

export function recordsFor(
  host: FakeHostProfile,
  records: readonly CapabilityRecord[] = SEED_RECORDS,
): CapabilityRecord[] {
  return records.filter((record) => record.host === host);
}

/** Newest record for a host (by measuredAt, then version string). */
export function newestRecord(
  host: FakeHostProfile,
  records: readonly CapabilityRecord[] = SEED_RECORDS,
): CapabilityRecord {
  const found = recordsFor(host, records);
  if (!found.length) throw new Error(`no capability record for host ${host}`);
  const sorted = [...found].sort((a, b) =>
    a.measuredAt < b.measuredAt ? -1 : a.measuredAt > b.measuredAt ? 1 : a.version < b.version ? -1 : 1,
  );
  return sorted[sorted.length - 1] as CapabilityRecord;
}

/** True when `profileVersion` is older than the newest record for that host. */
export function profileIsStale(
  host: FakeHostProfile,
  profileVersion: string,
  records: readonly CapabilityRecord[] = SEED_RECORDS,
): boolean {
  const newest = newestRecord(host, records);
  return newest.version !== profileVersion;
}

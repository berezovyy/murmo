// Measured host profiles generated from capability records. Historical
// profiles never claim 2.0-pre guarantees no real adapter has shown.

import type { Cancellation, Draft, DraftDelta, Edit, EditResult, Origin } from '@murmo/api';
import { isCanonicalKey, NAMED_KEYS } from '@murmo/api';
import { FakeAdapter, type FakeAdapterOptions, type PacketPart, patchCaps, referenceCaps } from './adapter.ts';
import {
  type CapabilityRecord,
  type FakeHostProfile,
  type HostQuirk,
  historicalFloor,
  newestRecord,
} from './records.ts';

export type { FakeHostProfile, PacketPart };

/** One native editor slot, scoped to a fake host. Never a process-global singleton. */
export class FakeEditorSlot {
  #owner: string | null = null;
  #lease: symbol | null = null;

  acquire(owner: string): { (): void; current(): boolean } {
    if (this.#owner !== null) throw new Error(`Pi has one editor slot; already owned by ${this.#owner}`);
    const lease = Symbol(owner);
    this.#owner = owner;
    this.#lease = lease;
    const release = () => {
      if (this.#lease === lease) {
        this.#owner = null;
        this.#lease = null;
      }
    };
    return Object.assign(release, { current: () => this.#lease === lease });
  }

  /** Native setEditorComponent semantics: replacing a factory displaces the old owner. */
  replace(owner: string): { displaced: string | null; release: ReturnType<FakeEditorSlot['acquire']> } {
    const displaced = this.#owner;
    this.#owner = null;
    this.#lease = null;
    return { displaced, release: this.acquire(owner) };
  }

  current(): string | null {
    return this.#owner;
  }
}

export const profileEvidence = {
  claude: {
    version: '2.1.304',
    report: 'docs/experiments/r13-claude-inline.md',
    limits: [
      'keyless-bursts-have-unknown-origin',
      'no-async-CAS',
      'partial-key-observation',
      'menu-enter-dismisses-via-submit-boundary',
    ],
  },
  codex: {
    version: '0.163.0',
    report: 'docs/experiments/r13-codex-inline.md',
    limits: ['Tab-queues', 'tracked-draft', 'managed-submit-boundary', 'native-popup-tab-passes'],
  },
  opencode: {
    version: '2.1.0',
    report: 'docs/experiments/r13-opencode-inline.md',
    limits: ['packet-paste-after-following-typing', 'managed-submit-boundary', 'footer-status'],
  },
  pi: {
    version: '1.3.0',
    report: 'docs/experiments/r13-pi-inline.md',
    limits: ['one-editor-slot', 'opaque-paste-uneditable', 'managed-submit-boundary'],
  },
} as const;

function printableKeys(): string[] {
  return Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).filter(isCanonicalKey);
}

function claudeKeys(): string[] {
  const hidden = new Set(['Tab', 'Enter', 'F6']);
  return ['space', 'Backspace', ...NAMED_KEYS, ...printableKeys()].filter((key) => !hidden.has(key));
}

export function capsFromRecord(record: CapabilityRecord) {
  const base = patchCaps(referenceCaps(), historicalFloor());
  const patched = patchCaps(base, record.patch);
  if (record.host === 'claude') {
    return patchCaps(patched, { keys: claudeKeys() });
  }
  return patched;
}

export interface ProfiledFakeAdapterOptions extends FakeAdapterOptions {
  readonly editorSlot?: FakeEditorSlot;
  readonly owner?: string;
  readonly record?: CapabilityRecord;
}

/** Historical measured profiles, not probes or claims about later host versions. */
export class ProfiledFakeAdapter extends FakeAdapter {
  readonly profile: FakeHostProfile;
  readonly record: CapabilityRecord;
  readonly quirks: ReadonlySet<HostQuirk>;
  #releaseEditor: ReturnType<FakeEditorSlot['acquire']> | undefined;
  readonly #slot: FakeEditorSlot | undefined;
  readonly #owner: string;

  constructor(profile: FakeHostProfile, options: ProfiledFakeAdapterOptions = {}) {
    const record = options.record ?? newestRecord(profile);
    const quirks = new Set(record.quirks);
    super({
      ...options,
      caps: capsFromRecord(record),
      host: { name: profile, version: `${record.version}-fake-profile` },
      draft: {
        text: options.draft?.text ?? '',
        ...(options.draft?.cursor === undefined ? {} : { cursor: options.draft.cursor }),
        certainty: quirks.has('tracked-draft') ? 'tracked' : (options.draft?.certainty ?? 'authoritative'),
      },
    });
    this.profile = profile;
    this.record = record;
    this.quirks = quirks;
    this.#slot = options.editorSlot;
    this.#owner = options.owner ?? 'murmo';
    if (this.quirks.has('Tab-queues')) this.tabQueues = true;
    if (this.quirks.has('footer-status')) this.statusSlot = 'footer';
  }

  override async ready() {
    if (this.profile === 'pi' && this.#slot && !this.#releaseEditor) {
      this.#releaseEditor = this.#slot.acquire(this.#owner);
    }
    try {
      return await super.ready();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  override dispose(): void {
    this.#releaseEditor?.();
    this.#releaseEditor = undefined;
  }

  #editorLost(): boolean {
    return this.profile === 'pi' && !!this.#slot && !!this.#releaseEditor && !this.#releaseEditor.current();
  }

  override getDraft() {
    const draft = super.getDraft();
    if (this.#editorLost()) return { ...draft, certainty: 'unknown' as const, typedSpans: [] };
    return draft;
  }

  override fill(text: string, origin: Origin, cursor = text.length): void {
    const mapped =
      (this.quirks.has('paste-unknown-origin') && origin === 'paste') || this.quirks.has('tracked-draft')
        ? 'unknown'
        : origin;
    super.fill(text, mapped, cursor);
  }

  override burst(
    deltas: readonly { origin: Origin; text: string; from?: number; to?: number }[],
    key = 'Text',
    deferred?: Parameters<FakeAdapter['burst']>[2],
  ): void {
    const mapped = this.quirks.has('keyless-bursts-have-unknown-origin')
      ? deltas.map((d) => ({ ...d, origin: 'unknown' as const }))
      : deltas;
    super.burst(mapped, key, deferred);
  }

  override packet(parts: readonly PacketPart[]): void {
    const ordered = this.quirks.has('packet-paste-after-following-typing')
      ? [...parts.filter((p) => p.origin === 'typed'), ...parts.filter((p) => p.origin === 'paste')]
      : [...parts];
    super.packet(ordered);
  }

  override paste(text: string): void {
    if (this.quirks.has('paste-unknown-origin') || this.quirks.has('keyless-bursts-have-unknown-origin')) {
      const d = this.getDraft();
      const [from, to] = d.selection && d.selection[0] !== d.selection[1] ? d.selection : [d.cursor, d.cursor];
      this.burst([{ origin: 'unknown', text, from, to }], 'Text');
      return;
    }
    super.paste(text);
  }

  override async applyEditIfVersion(edit: Edit, signal?: Cancellation): Promise<EditResult> {
    if (this.#editorLost()) {
      return { status: 'denied', reason: `Pi editor route was replaced by ${this.#slot?.current()}` };
    }
    if (!this.caps.edit.atomic) {
      return { status: 'unsupported', reason: `${this.profile} has no asynchronous atomic edit` };
    }
    return super.applyEditIfVersion(edit, signal);
  }

  override async restoreDraft(draft: Draft, version: number, signal?: Cancellation): Promise<EditResult> {
    if (this.#editorLost()) return { status: 'denied', reason: 'Pi editor route was replaced' };
    if (!this.caps.edit.exactRestore) {
      return { status: 'unsupported', reason: `${this.profile} has no exact asynchronous restore` };
    }
    return super.restoreDraft(draft, version, signal);
  }
}

export function makeAdapter(
  profile: FakeHostProfile | 'fake' | undefined,
  options?: ProfiledFakeAdapterOptions,
): FakeAdapter {
  if (!profile || profile === 'fake') return new FakeAdapter(options);
  return new ProfiledFakeAdapter(profile, options);
}

export type { DraftDelta };

// The commit path for plugin edits and the session's own restores. A version
// check before an asynchronous edit still let it overwrite newer typing
// (lesson 47), so the check is repeated at the native commit: the adapter's
// `applyEditIfVersion` compares the version there and returns the snapshot it
// committed, which becomes the session's draft. A commit that does not apply
// changes nothing and arms no undo.
//
// The steps, in order (docs/plan/05 § Edits):
// 1. the ticket is current and the edit's base version is the draft's, else `stale`;
// 2. the draft is editable, else `denied`;
// 3. the host's edit capabilities fit, else `unsupported` (never a whole-buffer fallback);
// 4. the inserted text is safe, else `denied`;
// 5. commit gates: phase 08 adds the submit window, phase 09 permission, edit rate and attribution;
// 6. the adapter commits; built-in plugins directly, third-party plugins through
//    the host-owned attribution route;
// 7. changes that arrive meanwhile are held and published afterwards (draft-state.ts).

import type { Cancellation, Certainty, Draft, Edit, EditResult, HostState, ResultCode } from '@murmo/api';
import type { Adapter, HostCapabilities } from '@murmo/api/adapter';
import { displayText, unsafeText } from '@murmo/text';
import type { Accepted, DraftState } from './draft-state.ts';
import type { PluginEntry } from './hooks.ts';
import { isCurrent, type SessionView, type Ticket } from './stale.ts';
import type { Counters } from './stats.ts';
import { restoredExactly, restoreTarget, type UndoGesture, type UndoLog, type UndoRecord } from './undo.ts';

/**
 * The state in which Murmo may change the draft: prose, insert mode, not busy,
 * no dialog, no popup, not browsing history, and a known draft. Unknown state
 * is never assumed to be prose (`editable()` in the prototype).
 */
export function editable(state: HostState, draft: Draft): boolean {
  return (
    state.mode === 'prose' &&
    state.editorMode === 'insert' &&
    !state.busy &&
    !state.dialog &&
    state.popup === null &&
    !state.history &&
    draft.certainty !== 'unknown'
  );
}

/**
 * The certainty mutability rule (phase 04 hand-off): `unknown` never permits a
 * mutation; `tracked` and `authoritative` do only where the host lists them in
 * `edit.certainties` (a probed capability).
 */
export function certaintyAllowsEdit(certainty: Certainty, caps: HostCapabilities): boolean {
  return certainty !== 'unknown' && caps.edit.certainties.includes(certainty);
}

/** Why the host can't take this edit (step 3), or null when it can. */
export function unsupportedReason(edit: Edit, draft: Draft, caps: HostCapabilities): string | null {
  const e = caps.edit;
  if (!e.atomic) return 'the host has no compare-and-set edit';
  if (!certaintyAllowsEdit(draft.certainty, caps)) return `edits are not allowed on a ${draft.certainty} draft`;
  const atEnd = draft.cursor === draft.text.length && edit.to === draft.text.length;
  if (atEnd ? !e.end : !e.middle) return atEnd ? 'the host cannot edit at the end' : 'the host cannot edit mid-draft';
  if (!e.multiline && edit.insert.includes('\n')) return 'the host cannot insert a newline';
  if (edit.cursor !== undefined && e.cursor !== true) return 'the host cannot place the cursor';
  return null;
}

/** Why the edit is malformed for this draft, or null. */
export function invalidReason(edit: Edit, draft: Draft): string | null {
  const { from, to, insert } = edit;
  if (typeof insert !== 'string') return 'insert is not a string';
  if (!Number.isInteger(from) || !Number.isInteger(to)) return 'range is not integer';
  if (from < 0 || to < from || to > draft.text.length) return `range [${from}, ${to}) is outside the draft`;
  if (edit.cursor !== undefined) {
    const length = draft.text.length - (to - from) + insert.length;
    if (!Number.isInteger(edit.cursor) || edit.cursor < 0 || edit.cursor > length) return 'cursor is outside the draft';
  }
  return null;
}

/** What a commit gate sees. */
export interface CommitRequest {
  readonly plugin: PluginEntry;
  readonly edit: Edit;
  readonly draft: Draft;
  readonly state: HostState;
}

/** A check at step 5; returns a denial reason, or null to let the commit go on. */
export interface CommitGate {
  readonly name: string;
  check(request: CommitRequest): string | null;
}

export interface EditDeps {
  readonly adapter: Adapter;
  readonly caps: HostCapabilities;
  readonly view: SessionView;
  readonly intake: DraftState;
  readonly undo: UndoLog;
  readonly counters: Counters;
  readonly gates: readonly CommitGate[];
  readonly notice: (text: string) => void;
  /** Publishes changes released after an own operation. */
  readonly publish: (accepted: readonly Accepted[]) => void;
  /** Phase 09: count an applied third-party edit toward the rate window. Phase 32: review log. */
  readonly noteApplied?: (plugin: PluginEntry, edit: Edit, draft: Draft) => void;
}

const codes: ReadonlySet<string> = new Set<ResultCode>([
  'applied',
  'stale',
  'denied',
  'unsupported',
  'invalid-range',
  'cancelled',
  'error',
]);

/** An adapter answer as the contract allows it: an `applied` result must carry the committed draft. */
function checked(result: EditResult | undefined): EditResult {
  if (!result || typeof result !== 'object' || !codes.has(result.status)) {
    return { status: 'error', reason: 'adapter returned no result code' };
  }
  if (result.status === 'applied' && (!result.draft || typeof result.draft.text !== 'string')) {
    return { status: 'error', reason: 'applied without the committed draft' };
  }
  return result;
}

async function settle(run: () => Promise<EditResult>): Promise<EditResult> {
  try {
    return checked(await run());
  } catch (error) {
    return { status: 'error', reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The host-owned attribution label of a third-party edit; the plugin supplies only its own label text. */
export function attributionLabel(plugin: PluginEntry, edit: Edit): string {
  return edit.label ? `Plugin ${plugin.id}: ${displayText(edit.label)}` : `Plugin ${plugin.id} edited this draft`;
}

export class Edits {
  readonly #deps: EditDeps;

  constructor(deps: EditDeps) {
    this.#deps = deps;
  }

  /** Commits one plugin edit; the result is counted and returned, never thrown. */
  async commit(plugin: PluginEntry, edit: Edit, ticket: Ticket): Promise<ResultCode> {
    const status = await this.#commit(plugin, edit, ticket);
    this.#deps.counters.commits[status]++;
    return status;
  }

  async #commit(plugin: PluginEntry, edit: Edit, ticket: Ticket): Promise<ResultCode> {
    const { adapter, caps, view, intake, gates } = this.#deps;
    const before = view.draft;
    // 1. Current, and computed from this very draft.
    if (!isCurrent(ticket, view) || edit.baseVersion !== before.version) return 'stale';
    if (invalidReason(edit, before)) return 'invalid-range';
    // 2. Editable now.
    const state = view.state();
    if (!editable(state, before)) return 'denied';
    // 3. The host can take it.
    if (unsupportedReason(edit, before, caps)) return 'unsupported';
    // 4. Safe text only.
    if (unsafeText(edit.insert) !== null) {
      this.#deps.notice(`${plugin.name}: unsafe text rejected`);
      return 'denied';
    }
    // 5. Gates from the submit window and the permission layer.
    for (const gate of gates) {
      const reason = gate.check({ plugin, edit, draft: before, state });
      if (reason !== null) {
        this.#deps.counters.lastDeniedReason = reason;
        plugin.deniedEdits++;
        return 'denied';
      }
    }
    // 6. Commit at the host, comparing the version there. Attribution is a
    // phase 09 gate (`attribution`); missing support is denied there.
    const signal: Cancellation = {
      get cancelled() {
        return !isCurrent(ticket, view);
      },
    };
    const request: Edit = { ...edit };
    intake.hold();
    let result: EditResult;
    try {
      result = await settle(() =>
        plugin.builtin
          ? adapter.applyEditIfVersion(request, signal)
          : adapter.applyAttributedEditIfVersion(
              request,
              { pluginId: plugin.id, label: attributionLabel(plugin, edit), before },
              signal,
            ),
      );
      if (result.status === 'applied') {
        this.#deps.noteApplied?.(plugin, request, before);
        intake.adoptEdit(before, request, plugin.id, result.draft);
        // Undo is armed only if no key came in while the commit was in flight.
        if (edit.undoable && view.epoch === ticket.epoch) {
          this.#deps.undo.push({
            before,
            after: intake.draft,
            owner: plugin.id,
            rejectSeparator: edit.rejectSeparator === true,
          });
        }
      }
    } finally {
      this.#deps.publish(intake.release());
    }
    return result.status;
  }

  /**
   * Restores the draft before a Murmo edit, exactly (text, cursor, selection,
   * typed spans), if the draft is still the version the edit produced. The
   * caller already took the record off the log.
   */
  async restore(record: UndoRecord, gesture: UndoGesture, epoch: number): Promise<ResultCode> {
    const { adapter, view, intake, undo, counters } = this.#deps;
    const target = restoreTarget(record, gesture);
    const signal: Cancellation = {
      get cancelled() {
        return !view.alive || view.epoch !== epoch;
      },
    };
    intake.hold();
    let result: EditResult;
    try {
      result = await settle(() => adapter.restoreDraft(target, record.after.version, signal));
      if (result.status === 'applied') {
        counters.restores++;
        if (!restoredExactly(result.draft, target)) counters.restoreMismatches++;
        intake.adoptRestore(target, result.draft);
        undo.rebase(target, intake.draft);
      } else undo.clear();
    } finally {
      this.#deps.publish(intake.release());
    }
    return result.status;
  }
}

// Hold GhostProposal until native idle, then apply the ordinary 2.0-pre ghost
// only if the draft is empty with known certainty, no popup/dialog, same
// session, not superseded, not expired. Any typed key drops it (rule 2).

import type { ActionResult, Draft, HostState } from '@murmo/api';
import type { GhostProposal } from '@murmo/api/events';

export interface GhostSink {
  apply(pluginId: string, text: string, version: number): ActionResult | Promise<ActionResult>;
}

export interface HeldGhost {
  readonly pluginId: string;
  readonly proposal: GhostProposal;
}

export class GhostBroker {
  #held: HeldGhost | undefined;
  #typed = false;
  #sessionId: string | undefined;
  #superseded = false;

  hold(pluginId: string, proposal: GhostProposal): void {
    this.#held = { pluginId, proposal };
    this.#superseded = false;
  }

  noteSession(sessionId: string): void {
    if (this.#sessionId && this.#sessionId !== sessionId) this.#superseded = true;
    this.#sessionId = sessionId;
  }

  noteTypedKey(): void {
    this.#typed = true;
    this.#held = undefined;
  }

  noteNewRun(): void {
    this.#superseded = true;
    this.#held = undefined;
  }

  resetIdleGate(): void {
    this.#typed = false;
  }

  held(): HeldGhost | undefined {
    return this.#held;
  }

  async applyIfReady(
    nowMs: number,
    draft: Draft,
    state: HostState,
    sink: GhostSink,
  ): Promise<ActionResult | undefined> {
    const held = this.#held;
    this.#held = undefined;
    if (!held) return undefined;
    const { proposal, pluginId } = held;
    if (proposal.when !== 'empty-native-idle')
      return { status: 'denied', reason: 'ghost when is not empty-native-idle' };
    if (nowMs >= proposal.expiresAtMs) return { status: 'stale', reason: 'ghost expired' };
    if (this.#typed) return { status: 'denied', reason: 'typed key dropped the ghost' };
    if (this.#superseded) return { status: 'stale', reason: 'originating run was superseded' };
    if (this.#sessionId && proposal.origin.sessionId !== this.#sessionId) {
      return { status: 'stale', reason: 'ghost session mismatch' };
    }
    if (draft.text !== '') return { status: 'denied', reason: 'draft is not empty' };
    if (draft.certainty === 'unknown') return { status: 'denied', reason: 'draft certainty is unknown' };
    if (state.popup || state.dialog) return { status: 'denied', reason: 'popup or dialog is open' };
    if (state.busy) return { status: 'denied', reason: 'agent is still busy' };
    return sink.apply(pluginId, proposal.text, draft.version);
  }
}

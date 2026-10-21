// isCurrent is the stale-result contract (E2, lesson 6): every field that can
// make a late result overwrite newer typing must independently drop it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Draft, HostState } from '@murmo/api';
import { isCurrent, issueTicket, type SessionView, type StaleReason, staleReason, type Ticket } from '../src/stale.ts';

const draft = (extra: Partial<Draft> = {}): Draft => ({
  text: 'ab',
  cursor: 2,
  version: 3,
  certainty: 'authoritative',
  typedSpans: [[0, 2]],
  ...extra,
});

const state = (extra: Partial<HostState> = {}): HostState => ({
  mode: 'prose',
  popup: null,
  dialog: false,
  busy: false,
  editorMode: 'insert',
  history: false,
  ...extra,
});

function view(
  extra: Partial<{
    alive: boolean;
    owner: boolean;
    epoch: number;
    draft: Draft;
    host: HostState;
    enabled: boolean;
    latestSeq: number;
  }> = {},
): SessionView {
  const d = extra.draft ?? draft();
  const host = extra.host ?? state();
  return {
    get alive() {
      return extra.alive ?? true;
    },
    get owner() {
      return extra.owner ?? true;
    },
    get epoch() {
      return extra.epoch ?? 1;
    },
    get draft() {
      return d;
    },
    state: () => host,
    enabled: () => extra.enabled ?? true,
    latestSeq: () => extra.latestSeq ?? 7,
  };
}

function ticketOf(v: SessionView, extra: Partial<Ticket> = {}): Ticket {
  return { ...issueTicket('p', 'onChange', extra.seq ?? 7, v), ...extra };
}

function drops(reason: StaleReason, v: SessionView, extra: Partial<Ticket> = {}): void {
  const ticket = ticketOf(view(), extra);
  assert.equal(staleReason(ticket, v), reason, reason);
  assert.equal(isCurrent(ticket, v), false, reason);
}

test('a ticket matching the live session is current', () => {
  const v = view();
  assert.equal(staleReason(ticketOf(v), v), null);
  assert.equal(isCurrent(ticketOf(v), v), true);
});

test('each stale-result field independently drops a late result (E2, lesson 6)', () => {
  drops('disposed', view({ alive: false }));
  drops('disabled', view({ enabled: false }));
  drops('owner', view({ owner: false }));
  drops('owner', view(), { owner: false });
  drops('superseded', view({ latestSeq: 8 }));
  drops('epoch', view({ epoch: 2 }));
  drops('version', view({ draft: draft({ version: 4 }) }));
  drops('text', view({ draft: draft({ text: 'abc', cursor: 3 }) }));
  drops('cursor', view({ draft: draft({ cursor: 1 }) }));
  drops('editor-mode', view({ host: state({ editorMode: 'normal' }) }));
  drops('popup', view({ host: state({ popup: { owner: 'host' } }) }));
  drops('dialog', view({ host: state({ dialog: true }) }));
});

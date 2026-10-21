// The stale-result contract, as one function every asynchronous path calls
// (02-architecture § The adapter–engine contract, from pi-prompt-autocomplete's
// `isRequestStillCurrent`). A result applies only while the session is alive,
// the plugin is enabled, this editor owns the prompt, no newer request of the
// same hook was issued, the key epoch, draft version, text, cursor and editor
// mode are unchanged, and no host popup or dialog is open. Grammar Guard and
// Prompt Line overwrote newer typing without this check (lesson 6). Stale work
// is dropped, never queued (lesson 17).

import type { Draft, HostState, PluginHook } from '@murmo/api';

/** Issued when an asynchronous request starts; everything its result may depend on. */
export interface Ticket {
  readonly pluginId: string;
  readonly hook: PluginHook;
  readonly epoch: number;
  /** Session-wide request sequence; only the latest request per plugin and hook is current. */
  readonly seq: number;
  readonly version: number;
  readonly text: string;
  readonly cursor: number;
  readonly editorMode: HostState['editorMode'];
  readonly owner: boolean;
}

/** The session as `isCurrent` reads it: always the live values. */
export interface SessionView {
  readonly alive: boolean;
  /** This editor owns the prompt (subscribed and not turned off). */
  readonly owner: boolean;
  readonly epoch: number;
  readonly draft: Draft;
  /** The host state, read live from the adapter. */
  state(): HostState;
  enabled(pluginId: string): boolean;
  latestSeq(pluginId: string, hook: PluginHook): number;
}

export type StaleReason =
  | 'disposed'
  | 'disabled'
  | 'owner'
  | 'superseded'
  | 'epoch'
  | 'version'
  | 'text'
  | 'cursor'
  | 'editor-mode'
  | 'popup'
  | 'dialog';

export function issueTicket(pluginId: string, hook: PluginHook, seq: number, view: SessionView): Ticket {
  const { draft } = view;
  return {
    pluginId,
    hook,
    epoch: view.epoch,
    seq,
    version: draft.version,
    text: draft.text,
    cursor: draft.cursor,
    editorMode: view.state().editorMode,
    owner: view.owner,
  };
}

/** Why the ticket's result can no longer apply, or null while it is current. */
export function staleReason(ticket: Ticket, view: SessionView): StaleReason | null {
  if (!view.alive) return 'disposed';
  if (!view.enabled(ticket.pluginId)) return 'disabled';
  if (!ticket.owner || !view.owner) return 'owner';
  if (view.latestSeq(ticket.pluginId, ticket.hook) !== ticket.seq) return 'superseded';
  if (ticket.epoch !== view.epoch) return 'epoch';
  const { draft } = view;
  if (ticket.version !== draft.version) return 'version';
  // The version should catch every change; text and cursor are compared too,
  // because an adapter that misses one version bump must still not overwrite.
  if (ticket.text !== draft.text) return 'text';
  if (ticket.cursor !== draft.cursor) return 'cursor';
  const state = view.state();
  if (ticket.editorMode !== state.editorMode) return 'editor-mode';
  if (state.popup) return 'popup';
  if (state.dialog) return 'dialog';
  return null;
}

export function isCurrent(ticket: Ticket, view: SessionView): boolean {
  return staleReason(ticket, view) === null;
}

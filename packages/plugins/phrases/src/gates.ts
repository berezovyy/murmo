// When a ghost may appear. Fail closed: unknown certainty, a menu, a busy
// agent, a command prefix or a path-shaped last token keep it off (E9).

import type { Draft, HostName, HostState } from '@murmo/api';
import type { PhrasesSettings } from './settings.ts';

export const MIN_PREFIX_WORDS = 2;
export const MAX_PREFIX_WORDS = 10;

export type GhostRoute = 'ghost' | 'menu' | 'off';

const LAST_SKIP = /^[/!@#]/;
const PATHISH = /[/\\]/;

export function ghostRoute(
  host: HostName,
  settings: PhrasesSettings,
  capsGhost: 'none' | 'end-only' | 'any',
): GhostRoute {
  if (!settings.ghost) return 'off';
  if (host === 'codex') return 'off';
  if (capsGhost === 'none') return host === 'claude' ? 'menu' : 'off';
  if (host === 'claude') return 'menu';
  return 'ghost';
}

export interface GateInput {
  readonly draft: Draft;
  readonly state: HostState;
  readonly settings: PhrasesSettings;
  readonly route: GhostRoute;
}

export type GateReason =
  | 'off'
  | 'busy'
  | 'menu'
  | 'mode'
  | 'certainty'
  | 'cursor'
  | 'command'
  | 'short'
  | 'last-token'
  | 'ok';

export function lastLine(text: string): string {
  const at = text.lastIndexOf('\n');
  return at < 0 ? text : text.slice(at + 1);
}

export function prefixWords(line: string): string[] {
  return line.match(/[A-Za-z0-9]+/g) ?? [];
}

/** Trailing 2–10 words, with a trailing space if the line ends in whitespace. */
export function prefixCandidates(text: string): string[] {
  const line = lastLine(text);
  const words = prefixWords(line);
  if (words.length < MIN_PREFIX_WORDS) return [];
  const space = /[ \t]$/.test(line);
  const out: string[] = [];
  const max = Math.min(MAX_PREFIX_WORDS, words.length);
  for (let n = max; n >= MIN_PREFIX_WORDS; n--) {
    const joined = words.slice(-n).join(' ');
    out.push(space ? `${joined} ` : joined);
  }
  return out;
}

export function ghostGates(input: GateInput): GateReason {
  if (input.route === 'off') return 'off';
  const { draft, state, settings } = input;
  if (state.mode === 'shell' || state.mode === 'command' || state.mode === 'unknown') return 'mode';
  if (state.popup !== null || state.dialog || state.history) return 'menu';
  if (settings.skipWhenBusy && state.busy) return 'busy';
  if (draft.certainty === 'unknown') return 'certainty';
  if (draft.cursor !== draft.text.length) return 'cursor';
  const line = lastLine(draft.text);
  const trimmed = line.replace(/^[ \t]+/, '');
  if (trimmed.startsWith('/') || trimmed.startsWith('!')) return 'command';
  if (prefixWords(line).length < MIN_PREFIX_WORDS) return 'short';
  const raw = /\S+$/.exec(line)?.[0];
  if (raw && (LAST_SKIP.test(raw) || PATHISH.test(raw))) return 'last-token';
  return 'ok';
}

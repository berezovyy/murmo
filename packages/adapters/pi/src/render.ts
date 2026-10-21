// Decorate host rows in place: end-only ghost, own menu, visible-row underline,
// status. Every row stays ≤ width. Host rows are taken first; this function
// must not throw into the TUI (lesson 15).

import type { Range } from '@murmo/api';
import { displayText } from '@murmo/text';
import { clipVisible, visibleWidth } from './ansi.ts';
import { type CursorHit, cursorMarker, detectCursorFormat, fakeCursorCell } from './cursor.ts';
import type { TuiApi } from './types.ts';

export interface GhostPaint {
  readonly text: string;
  readonly owner?: string;
}

export interface MenuPaint {
  readonly items: readonly { readonly label: string; readonly detail?: string; readonly owner?: string }[];
  readonly selected: number;
}

export interface RenderPaint {
  readonly ghost?: GhostPaint | null;
  readonly menu?: MenuPaint | null;
  readonly highlight?: readonly Range[] | null;
  readonly status?: string | null;
  readonly draftText?: string;
  readonly hideGhost?: boolean;
}

function measureOf(api: TuiApi): ((text: string) => number) | undefined {
  return typeof api.visibleWidth === 'function' ? (text) => api.visibleWidth?.(text) ?? visibleWidth(text) : undefined;
}

function fit(text: string, width: number, api: TuiApi): string {
  const measure = measureOf(api);
  if (typeof api.truncateToWidth === 'function') {
    const truncated = api.truncateToWidth(text, width);
    return visibleWidth(truncated, measure) <= width ? truncated : clipVisible(truncated, width, measure);
  }
  return clipVisible(text, width, measure);
}

function paintGhost(row: string, hit: CursorHit, ghost: string, width: number, api: TuiApi): string {
  const marker = cursorMarker(api);
  const spaceCell = marker + fakeCursorCell(api, ' ');
  let at = row.indexOf(spaceCell);
  if (at < 0) at = hit.at;
  if (at < 0) return row;
  const first = ghost[0] ?? ' ';
  const rest = ghost.slice(1);
  const painted = `${row.slice(0, at)}${marker}\x1b[2m${fakeCursorCell(api, first)}${rest}\x1b[22m`;
  const used = visibleWidth(painted, measureOf(api));
  if (used > width) return row;
  const tail = row.slice(at + spaceCell.length);
  const pad = Math.max(0, width - used);
  const spaces = ' '.repeat(Math.max(rest.length, 0));
  const after = tail.startsWith(spaces) ? tail.slice(spaces.length) : tail;
  return fit(painted + after, width, api) + (pad > visibleWidth(painted + after, measureOf(api)) ? '' : '');
}

function underline(row: string, word: string, width: number, api: TuiApi): string {
  if (!word || word.includes('\n')) return row;
  const at = row.indexOf(word);
  if (at < 0 || at !== row.lastIndexOf(word)) return row;
  return fit(`${row.slice(0, at)}\x1b[4m${word}\x1b[24m${row.slice(at + word.length)}`, width, api);
}

export function decorateRows(rows: readonly string[], width: number, paint: RenderPaint, api: TuiApi): string[] {
  try {
    return decorateRowsInner(rows, width, paint, api);
  } catch {
    return rows.map((row) => clipVisible(row, width, measureOf(api)));
  }
}

function decorateRowsInner(rows: readonly string[], width: number, paint: RenderPaint, api: TuiApi): string[] {
  const out = rows.map((row) =>
    visibleWidth(row, measureOf(api)) > width ? clipVisible(row, width, measureOf(api)) : row,
  );
  const hit = detectCursorFormat(out, api);
  if (hit && paint.highlight && paint.draftText) {
    const row = out[hit.row];
    if (row) {
      for (const [from, to] of paint.highlight) {
        const word = paint.draftText.slice(from, to);
        out[hit.row] = underline(out[hit.row] ?? row, word, width, api);
      }
    }
  }
  if (hit && paint.ghost?.text && !paint.hideGhost) {
    const row = out[hit.row];
    if (row) out[hit.row] = paintGhost(row, hit, displayText(paint.ghost.text), width, api);
  }
  if (paint.menu?.items.length) {
    for (let i = 0; i < paint.menu.items.length; i++) {
      const item = paint.menu.items[i];
      if (!item) continue;
      const mark = i === paint.menu.selected ? '> ' : '  ';
      const owner = item.owner && item.owner !== 'murmo' ? `[plugin ${item.owner}] ` : '';
      const detail = item.detail ? `  ${item.detail}` : '';
      out.push(fit(displayText(`${mark}${owner}${item.label}${detail}`), width, api));
    }
  }
  if (paint.status) {
    for (const part of paint.status.split(' | ').slice(0, 5)) {
      out.push(fit(displayText(part), width, api));
    }
  }
  return out.map((row) => fit(row, width, api));
}

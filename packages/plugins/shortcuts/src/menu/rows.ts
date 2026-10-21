// Width-safe menu rows. Labels are cut to cells, never bytes: one cell too
// wide crashes Pi's TUI (lesson 3). Escaping uses `displayText` so controls
// never reach the terminal (lessons 60, 77).

import { type CellMeasure, clipToCells, codePointUnits, displayText } from '@murmo/text';
import { displayName, type PackedEntry } from './pack.ts';

const ELLIPSIS = '…';

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function isZeroWidth(cp: number): boolean {
  return (
    (cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0xfe0e || cp === 0x20e3
  );
}

/** Portable East-Asian / emoji width; adapters may pass the host's own measure. */
export function defaultCellMeasure(text: string): number {
  let cells = 0;
  for (let at = 0; at < text.length; ) {
    const units = codePointUnits(text, at);
    const cp = units === 2 ? (text.codePointAt(at) as number) : text.charCodeAt(at);
    at += units;
    if (isZeroWidth(cp)) continue;
    cells += isWide(cp) ? 2 : 1;
  }
  return cells;
}

function ellipsize(text: string, width: number, measure: CellMeasure): string {
  if (measure(text) <= width) return text;
  const mark = measure(ELLIPSIS);
  if (mark > width) return clipToCells(ELLIPSIS, width, measure);
  return clipToCells(text, width - mark, measure) + ELLIPSIS;
}

/**
 * `;rvw  Review this change…` — name, optional `project` tag when a project
 * entry overrides a personal one, then the first line, clipped to `width` cells.
 */
export function formatRow(entry: PackedEntry, width: number, measure: CellMeasure = defaultCellMeasure): string {
  const name = displayText(displayName(entry.name));
  const tag = entry.override ? '  project' : '';
  const head = `${name}${tag}  `;
  const rest = displayText(entry.firstLine);
  const used = measure(head);
  if (used >= width) return ellipsize(head.trimEnd(), width, measure);
  return head + ellipsize(rest, width - used, measure);
}

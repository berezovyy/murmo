// Ghost candidate: exact prefix, suffix only, clipped to the cells left on
// the row. Accept inserts that visible part, never hidden text (E9).

import { type CellMeasure, clipToCells, graphemeBoundaries } from '@murmo/text';
import { lastLine } from './gates.ts';
import { sanitizeCandidate } from './sanitize.ts';
import { defaultCellMeasure } from './width.ts';

export interface VisibleGhost {
  readonly phrase: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly visible: string;
}

export function remainingCells(text: string, rowCells: number, measure: CellMeasure = defaultCellMeasure): number {
  const used = measure(lastLine(text));
  return Math.max(0, rowCells - used);
}

export function clipGhost(suffix: string, cells: number, measure: CellMeasure = defaultCellMeasure): string {
  if (cells <= 0) return '';
  return clipToCells(suffix, cells, measure);
}

/** First grapheme of `text`, or empty. */
export function firstGrapheme(text: string): string {
  if (text.length === 0) return '';
  const bounds = graphemeBoundaries(text);
  const end = bounds[1] ?? text.length;
  return text.slice(0, end);
}

/**
 * When the user types the first grapheme of the shown ghost, slice the rest
 * locally without re-normalizing (knowledge § 2 prefix reuse).
 */
export function sliceMatching(ghost: string, typed: string): string | null {
  const g = firstGrapheme(ghost);
  if (g.length === 0 || typed !== g) return null;
  return ghost.slice(g.length);
}

export function makeVisible(
  phrase: string,
  prefix: string,
  text: string,
  rowCells: number,
  measure: CellMeasure = defaultCellMeasure,
): VisibleGhost | null {
  if (!phrase.startsWith(prefix) || phrase === prefix) return null;
  const raw = sanitizeCandidate(phrase.slice(prefix.length));
  if (raw.length === 0) return null;
  const visible = clipGhost(raw, remainingCells(text, rowCells, measure), measure);
  if (visible.length === 0) return null;
  return { phrase, prefix, suffix: raw, visible };
}

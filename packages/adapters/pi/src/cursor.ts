// One detector for every cursor format Pi has shipped. Searching SGR after
// the TUI has rewritten APC is wrong (knowledge § Pi); we parse `render()`
// output, which still has APC `pi:c` / `pi:fc` or SGR 7m.

import { CURSOR_APC, FAKE_CURSOR_END, FAKE_CURSOR_START, type TuiApi } from './types.ts';

export type CursorFormat = 'pi:fc' | 'sgr-7m' | 'unknown';

export interface CursorHit {
  readonly format: CursorFormat;
  readonly row: number;
  readonly at: number;
  readonly cell: string;
}

const SGR_FAKE = '\x1b[7m \x1b[0m';
const SGR_FAKE_27 = '\x1b[7m \x1b[27m';

export function cursorMarker(api: TuiApi): string {
  return typeof api.CURSOR_MARKER === 'string' && api.CURSOR_MARKER ? api.CURSOR_MARKER : CURSOR_APC;
}

export function fakeCursorCell(api: TuiApi, ch = ' '): string {
  if (typeof api.renderFakeCursor === 'function') return api.renderFakeCursor(ch);
  return `${FAKE_CURSOR_START}${ch}${FAKE_CURSOR_END}`;
}

export function detectCursorFormat(rows: readonly string[], api?: TuiApi): CursorHit | undefined {
  const marker = api ? cursorMarker(api) : CURSOR_APC;
  for (let row = 0; row < rows.length; row++) {
    const text = rows[row] ?? '';
    const at = text.indexOf(marker);
    if (at < 0) continue;
    const after = text.slice(at + marker.length);
    if (after.startsWith(FAKE_CURSOR_START) || after.includes(FAKE_CURSOR_START)) {
      const start = text.indexOf(FAKE_CURSOR_START, at);
      const end = text.indexOf(FAKE_CURSOR_END, start + FAKE_CURSOR_START.length);
      const cell =
        start >= 0 && end >= 0
          ? text.slice(at, end + FAKE_CURSOR_END.length)
          : marker + fakeCursorCell(api ?? { parseKey: () => undefined, truncateToWidth: (s) => s }, ' ');
      return { format: 'pi:fc', row, at, cell };
    }
    if (after.startsWith('\x1b[7m') || after.includes('\x1b[7m')) {
      const sgr = after.startsWith('\x1b[7m \x1b[27m') || after.includes(SGR_FAKE_27) ? SGR_FAKE_27 : SGR_FAKE;
      return { format: 'sgr-7m', row, at, cell: marker + sgr };
    }
    return { format: 'unknown', row, at, cell: marker };
  }
  return undefined;
}

// Portable East-Asian / emoji width, same rules as the `;` menu rows, so a
// ghost one cell too wide cannot crash Pi (lesson 3).

import { type CellMeasure, codePointUnits } from '@murmo/text';

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

export const defaultCellMeasure: CellMeasure = (text) => {
  let cells = 0;
  for (let at = 0; at < text.length; ) {
    const units = codePointUnits(text, at);
    const cp = units === 2 ? (text.codePointAt(at) as number) : text.charCodeAt(at);
    at += units;
    if (isZeroWidth(cp)) continue;
    cells += isWide(cp) ? 2 : 1;
  }
  return cells;
};

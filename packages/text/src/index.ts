// @murmo/text: offsets, graphemes, cells and unsafe text, the same in every
// runtime (docs/plan/04). Every offset is a UTF-16 code unit unless a function
// says otherwise, and no function rounds a position: inside a character means
// null (or false), never the nearest boundary. No normalization anywhere;
// adapters report `ui.normalization` instead.

export { type CellMeasure, cellsToUtf16, clipToCells, utf16ToCells } from './cells.ts';
export {
  type CodePointStep,
  codePointBefore,
  codePoints,
  codePointUnits,
  isCodePointBoundary,
  isHighSurrogate,
  isLowSurrogate,
  isOffset,
  isSingleCodePoint,
  type Range,
  utf8Bytes,
  utf8Length,
} from './codepoints.ts';
export { graphemeBoundaries, isGraphemeBoundary, safeRange, segmenter } from './graphemes.ts';
export { type OffsetIndex, offsetIndex, type Unit, units } from './offsets.ts';
export {
  displayText,
  invisibleCodePointRanges,
  invisibleRuns,
  isInvisibleCodePoint,
  unsafeText,
} from './unsafe.ts';

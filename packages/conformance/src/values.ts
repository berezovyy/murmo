import type { Count, TextSpec } from '@murmo/fixtures';

/** The string a TextSpec stands for. */
export function resolveText(spec: TextSpec): string {
  if (typeof spec === 'string') return spec;
  if (Array.isArray(spec)) return spec.map(resolveText).join('');
  return spec.repeat.repeat(spec.times);
}

/** Structural equality for JSON values; object key order does not matter. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return (
    ak.length === bk.length &&
    ak.every(
      (k) => Object.hasOwn(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    )
  );
}

export function withinCount(count: Count, actual: number): boolean {
  if (typeof count === 'number') return actual === count;
  return (count.min === undefined || actual >= count.min) && (count.max === undefined || actual <= count.max);
}

/** C0 and C1 controls, DEL, bidi embeddings, overrides and isolates: never safe on a terminal (lessons 60, 77). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
export const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u{202A}-\u{202E}\u{2066}-\u{2069}]/u;

/** Shortens long values in assertion messages, so a 4 MiB draft does not flood a verdict. */
export function preview(value: unknown, max = 160): unknown {
  if (typeof value === 'string' && value.length > max) {
    return `${value.slice(0, max / 2)}…(${value.length} units)…${value.slice(-max / 2)}`;
  }
  return value;
}

// Placeholder grammar for `[replace.<shortcut>]` templates (docs/plan/37).
// `<name>` with name `[a-z][a-z0-9_-]{0,31}` is a field; `<<` is a literal `<`;
// uppercase, HTML and `Vec<T>` stay literal. Defaults are inserted as written.

import { CONFIG_LIMITS, FIELD_NAME } from '@murmo/config';
import { unsafeText } from '@murmo/text';

export { FIELD_NAME };

export const MAX_FIELDS = CONFIG_LIMITS.fieldsPerTemplate;

export interface FieldOccurrence {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  /** Text at this occurrence: the default, or `<name>`. */
  readonly text: string;
  readonly filled: boolean;
}

export interface ParsedTemplate {
  readonly expansion: string;
  readonly fields: readonly FieldOccurrence[];
  /** Unique names in first-appearance order, at most `MAX_FIELDS`. */
  readonly names: readonly string[];
  readonly firstField: number | null;
}

const NAME_BODY = /^[a-z][a-z0-9_-]{0,31}/;

/**
 * Walk `source` left to right. `defaults` is name → literal default; a missing
 * name inserts the visible placeholder. Extra unique names after 16 are literal.
 */
export function parseTemplate(source: string, defaults: Readonly<Record<string, string>> = {}): ParsedTemplate {
  let expansion = '';
  const fields: FieldOccurrence[] = [];
  const names: string[] = [];
  let i = 0;
  while (i < source.length) {
    if (source[i] === '<' && source[i + 1] === '<') {
      expansion += '<';
      i += 2;
      continue;
    }
    if (source[i] === '<') {
      const rest = source.slice(i + 1);
      const match = NAME_BODY.exec(rest);
      const name = match?.[0];
      if (name && rest[name.length] === '>' && FIELD_NAME.test(name)) {
        const known = names.includes(name);
        if (known || names.length < MAX_FIELDS) {
          if (!known) names.push(name);
          const fallback = `<${name}>`;
          const raw = Object.hasOwn(defaults, name) ? defaults[name] : undefined;
          const text = raw === undefined || unsafeText(raw) !== null ? fallback : raw;
          const from = expansion.length;
          expansion += text;
          fields.push({ name, from, to: from + text.length, text, filled: text !== fallback });
          i += 2 + name.length;
          continue;
        }
      }
    }
    expansion += source[i];
    i++;
  }
  return {
    expansion,
    fields,
    names,
    firstField: fields[0]?.from ?? null,
  };
}

export function defaultsOf(
  fields: Readonly<Record<string, { readonly default?: string }>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (!fields) return out;
  for (const [name, spec] of Object.entries(fields)) {
    if (typeof spec?.default === 'string' && unsafeText(spec.default) === null) out[name] = spec.default;
  }
  return out;
}

/** Visible placeholder still in the draft, i.e. the user has not filled it. */
export function placeholderOf(name: string): string {
  return `<${name}>`;
}

export function unfilledCount(text: string, names: readonly string[]): number {
  let n = 0;
  for (const name of names) if (text.includes(placeholderOf(name))) n++;
  return n;
}

export function unfilledMessage(count: number): string {
  const noun = count === 1 ? 'field' : 'fields';
  return `${count} template ${noun} not filled; Enter again to send anyway`;
}

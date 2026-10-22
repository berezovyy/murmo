// RFC 8785 JCS restricted to the values integrity.json uses: objects, arrays,
// strings, integers, booleans, null. Plugin envelopes in phase 28 reuse this
// encoder (docs/plan/26 task 6).

export class CanonicalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalError';
  }
}

/** UTF-8 bytes of the canonical form, with no trailing newline. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

export function canonicalJson(value: unknown): string {
  return write(value);
}

function write(value: unknown): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  switch (typeof value) {
    case 'number':
      if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
        throw new CanonicalError(`canonical JSON only allows safe integers, got ${value}`);
      }
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object':
      if (Array.isArray(value)) return `[${value.map(write).join(',')}]`;
      return writeObject(value as Record<string, unknown>);
    default:
      throw new CanonicalError(`canonical JSON cannot encode ${typeof value}`);
  }
}

function writeObject(value: Record<string, unknown>): string {
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const key of keys) {
    const item = value[key];
    if (item === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${write(item)}`);
  }
  return `{${parts.join(',')}}`;
}

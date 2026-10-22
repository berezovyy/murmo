// FNV-1a 64-bit of JSON. Tool inputs are untrusted; the audit log stores this
// hash, never the raw command (plan/39).

export function hashJson(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? 'null';
  } catch {
    text = '"unserializable"';
  }
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i) & 0xffff);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

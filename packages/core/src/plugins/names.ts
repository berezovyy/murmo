// Display-name checks are a supplement to host-owned id prefixes (FEEDBACK S4b).
// A blacklist is not a guarantee: a homoglyph SYSTEM still needs the real-id prefix.

const RESERVED = ['system', 'permission', 'murmo', 'claude', 'codex', 'opencode', 'pi', 'openai', 'anthropic'];

export interface NameFlags {
  readonly nfkc: string;
  readonly reserved: boolean;
  readonly mixedScript: boolean;
}

function nfkcOf(text: string): string {
  try {
    return text.normalize('NFKC');
  } catch {
    return text;
  }
}

function scriptOf(code: number): 'latin' | 'cyrillic' | 'greek' | null {
  if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0xc0 && code <= 0x24f)) {
    return 'latin';
  }
  if ((code >= 0x370 && code <= 0x3ff) || (code >= 0x1f00 && code <= 0x1fff)) return 'greek';
  if ((code >= 0x400 && code <= 0x52f) || (code >= 0x2de0 && code <= 0x2dff) || (code >= 0xa640 && code <= 0xa69f)) {
    return 'cyrillic';
  }
  return null;
}

function mixedScript(text: string): boolean {
  const seen = new Set<string>();
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    const script = scriptOf(code);
    if (script) seen.add(script);
    if (seen.size > 1) return true;
  }
  return false;
}

function reservedWord(folded: string): boolean {
  const words = folded
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.some((word) => RESERVED.includes(word));
}

export function inspectDisplayName(name: string): NameFlags {
  const nfkc = nfkcOf(name);
  return {
    nfkc,
    reserved: reservedWord(nfkc),
    mixedScript: mixedScript(name) || mixedScript(nfkc),
  };
}

/** Host-owned prefix; the plugin cannot fake it. */
export function attributedStatus(pluginId: string, text: string): string {
  return `[plugin ${pluginId}] ${text}`;
}

export function nameNotice(pluginId: string, name: string): string | null {
  const flags = inspectDisplayName(name);
  if (!flags.reserved && !flags.mixedScript) return null;
  const why = [flags.reserved ? 'reserved-word' : '', flags.mixedScript ? 'mixed-script' : '']
    .filter(Boolean)
    .join(', ');
  return `Plugin ${pluginId} display name flagged (${why}); rows stay prefixed with the real id`;
}

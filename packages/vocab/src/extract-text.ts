// Pure extractors: skip comments and strings, take whole identifiers, parse
// manifests and CSpell lists. No filesystem. Split components are fragments
// and are not returned (docs/plan/19 whole-identifier rule).

import { isCspellPath, isManifestPath, isSourcePath } from './exclusions.ts';
import { normalizeKey } from './normalize.ts';

const GENERATED = /(?:automatically generated|auto-generated|@generated|generated (?:by|from)|do not edit)/i;

/** True when the file header says the contents are generated. */
export function isGenerated(text: string): boolean {
  const header = text.slice(0, 4096);
  return GENERATED.test(header);
}

function keepTerm(raw: string, into: Set<string>): void {
  const key = normalizeKey(raw);
  if (key) into.add(key);
}

/**
 * Whole ASCII identifiers, skipping block/line comments and quoted strings.
 * Approximate on purpose: not a language parser (r6).
 */
export function identifiersIn(text: string): string[] {
  const found = new Set<string>();
  const re =
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[^\n]|[^'\\\n])*'|`(?:\\[\s\S]|[^`\\])*`|\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
  for (const match of text.matchAll(re)) {
    const ident = match[1];
    if (!ident) continue;
    keepTerm(ident, found);
  }
  return [...found];
}

function addName(value: unknown, into: Set<string>): void {
  if (typeof value !== 'string' || value.length === 0) return;
  const slash = value.lastIndexOf('/');
  const colon = value.lastIndexOf(':');
  const base = value.slice(Math.max(slash, colon) + 1);
  keepTerm(base, into);
  keepTerm(value, into);
}

function addKeys(record: unknown, into: Set<string>): void {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return;
  for (const key of Object.keys(record as Record<string, unknown>)) addName(key, into);
}

/** package.json: name, scripts, dependency keys. */
export function termsFromPackageJson(text: string): string[] {
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    return [];
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return [];
  const obj = json as Record<string, unknown>;
  const found = new Set<string>();
  addName(obj.name, found);
  addKeys(obj.scripts, found);
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    addKeys(obj[section], found);
  }
  return [...found];
}

/** Cargo.toml: [package] name, dependency keys, workspace members. */
export function termsFromCargoToml(text: string): string[] {
  const found = new Set<string>();
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const header = /^\[([^\]]+)\]/.exec(line);
    if (header) {
      section = (header[1] as string).trim();
      continue;
    }
    const name = /^name\s*=\s*"([^"]+)"/.exec(line);
    if (name && (section === 'package' || section === 'workspace.package')) addName(name[1], found);
    if (/(^|\.)dependencies$/.test(section) || section === 'workspace.dependencies') {
      const dep = /^([A-Za-z0-9_-]+)\s*=/.exec(line);
      if (dep) addName(dep[1], found);
    }
    if (section === 'workspace') {
      const member = /^\s*"([^"]+)"/.exec(line);
      if (member) {
        const path = member[1] as string;
        addName(path.slice(path.lastIndexOf('/') + 1), found);
      }
    }
  }
  return [...found];
}

/** pyproject.toml: project name and dependency names (PEP 508 first token). */
export function termsFromPyproject(text: string): string[] {
  const found = new Set<string>();
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const header = /^\[([^\]]+)\]/.exec(line);
    if (header) {
      section = (header[1] as string).trim();
      continue;
    }
    const name = /^name\s*=\s*"([^"]+)"/.exec(line);
    if (name && (section === 'project' || section === 'tool.poetry')) addName(name[1], found);
    if (section === 'project' || section === 'tool.poetry.dependencies' || section.startsWith('project.optional')) {
      for (const quoted of line.matchAll(/"([A-Za-z][A-Za-z0-9_.-]*)"/g)) addName(quoted[1], found);
      const dep = /^([A-Za-z][A-Za-z0-9_.-]*)\s*=/.exec(line);
      if (dep && dep[1] !== 'name') addName(dep[1], found);
    }
  }
  return [...found];
}

/** go.mod: module last component and require paths. */
export function termsFromGoMod(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/^(?:module|require)\s+(\S+)/gm)) addName(match[1], found);
  for (const match of text.matchAll(/^\s+(\S+)\s+v/gm)) addName(match[1], found);
  return [...found];
}

/** Makefile targets (`name:` not `name=`). */
export function termsFromMakefile(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)) addName(match[1], found);
  return [...found];
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

export interface CspellParse {
  readonly words: readonly string[];
  /** Dictionary files listed in this config, relative posix paths. */
  readonly dictionaries: readonly string[];
}

/** CSpell `words` plus listed dictionary file paths inside the repository. */
export function parseCspell(text: string): CspellParse {
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    return { words: [], dictionaries: [] };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return { words: [], dictionaries: [] };
  const obj = json as Record<string, unknown>;
  const words = [...stringList(obj.words), ...stringList(obj.flagWords), ...stringList(obj.ignoreWords)];
  const dictionaries: string[] = [];
  const defs = obj.dictionaryDefinitions;
  if (Array.isArray(defs)) {
    for (const def of defs) {
      if (typeof def !== 'object' || def === null) continue;
      const path = (def as { path?: unknown }).path;
      if (typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.includes('..')) {
        dictionaries.push(path.replaceAll('\\', '/'));
      }
    }
  }
  return { words, dictionaries };
}

/** One word per line, `#` comments dropped. */
export function termsFromWordList(text: string): string[] {
  const found = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    keepTerm(trimmed.split(/\s+/)[0] as string, found);
  }
  return [...found];
}

export function termsFromCspellWords(words: readonly string[]): string[] {
  const found = new Set<string>();
  for (const word of words) keepTerm(word, found);
  return [...found];
}

/**
 * Tokens one tracked file contributes: whole identifiers, manifest names,
 * CSpell words. Path names are added by the caller from the posix path.
 */
export function termsFromFile(posixPath: string, text: string): { tokens: string[]; dictionaries: string[] } {
  const tokens = new Set<string>();
  const add = (items: readonly string[]) => {
    for (const item of items) tokens.add(item);
  };
  if (isGenerated(text)) return { tokens: [], dictionaries: [] };
  const name = posixPath.slice(posixPath.lastIndexOf('/') + 1).toLowerCase();
  if (name === 'package.json') add(termsFromPackageJson(text));
  else if (name === 'cargo.toml') add(termsFromCargoToml(text));
  else if (name === 'pyproject.toml') add(termsFromPyproject(text));
  else if (name === 'go.mod') add(termsFromGoMod(text));
  else if (name === 'makefile' || name === 'gnumakefile') add(termsFromMakefile(text));
  if (isCspellPath(posixPath)) {
    const parsed = parseCspell(text);
    add(termsFromCspellWords(parsed.words));
    return { tokens: [...tokens], dictionaries: [...parsed.dictionaries] };
  }
  if (isSourcePath(posixPath)) add(identifiersIn(text));
  else if (!isManifestPath(posixPath) && text.includes('\n') && !name.endsWith('.json')) {
    // Dictionary files listed by CSpell: a word list, not source.
    add(termsFromWordList(text));
  }
  return { tokens: [...tokens], dictionaries: [] };
}

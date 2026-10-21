// Load-time collision warnings (lesson 27, r8 § 55): a bare shortcut that is
// also an English word, a typo-list key, or a project name is allowed, but we
// say so once. Prefixed names (`;fix`) empirically collide with none of those.

export type CollisionKind = 'word' | 'typo' | 'name';

export interface CollisionLexicon {
  hasWord(token: string): boolean;
  hasTypo(token: string): boolean;
  hasName(token: string): boolean;
}

/**
 * Common code identifiers from the r8 matched-pair check. Used when the host
 * has not injected a language-pack word list yet; never a refusal list.
 */
export const COMMON_IDENTIFIERS: readonly string[] = [
  'get',
  'set',
  'run',
  'add',
  'del',
  'new',
  'fix',
  'read',
  'write',
  'test',
  'parse',
  'build',
  'render',
  'init',
  'start',
  'stop',
  'main',
  'args',
  'argv',
  'opts',
  'config',
  'state',
  'cache',
  'error',
  'err',
  'log',
  'info',
  'warn',
  'debug',
  'data',
  'value',
  'key',
  'keys',
  'map',
  'filter',
  'reduce',
  'push',
  'pop',
  'shift',
  'length',
  'size',
  'name',
  'id',
  'ref',
  'req',
  'res',
  'ctx',
  'app',
  'api',
  'cli',
  'url',
  'uri',
  'path',
  'file',
  'dir',
  'src',
  'tmp',
  'env',
  'db',
  'sql',
  'auth',
  'done',
  'next',
  'help',
  'undo',
  'diff',
  'stat',
  'plan',
  'note',
  'result',
  'input',
  'output',
];

export function lexiconFromSets(sets: {
  readonly words?: Iterable<string> | undefined;
  readonly typos?: Iterable<string> | undefined;
  readonly names?: Iterable<string> | undefined;
}): CollisionLexicon {
  const words = new Set(sets.words ?? []);
  const typos = new Set(sets.typos ?? []);
  const names = new Set(sets.names ?? []);
  return {
    hasWord: (token) => words.has(token),
    hasTypo: (token) => typos.has(token),
    hasName: (token) => names.has(token),
  };
}

export function defaultLexicon(
  extra: {
    readonly words?: Iterable<string> | undefined;
    readonly typos?: Iterable<string> | undefined;
    readonly names?: Iterable<string> | undefined;
  } = {},
): CollisionLexicon {
  return lexiconFromSets({
    words: [...COMMON_IDENTIFIERS, ...(extra.words ?? [])],
    typos: extra.typos,
    names: extra.names,
  });
}

/** Word, then typo key, then project name; a warning, never a refusal. */
export function collisionKind(name: string, lexicon: CollisionLexicon): CollisionKind | null {
  if (lexicon.hasWord(name)) return 'word';
  if (lexicon.hasTypo(name)) return 'typo';
  if (lexicon.hasName(name)) return 'name';
  return null;
}

export function collisionNotice(name: string, kind: CollisionKind): string {
  const suggest = name.startsWith(';') ? name : `;${name}`;
  switch (kind) {
    case 'word':
      return `Shortcut "${name}" is also an English word; consider "${suggest}".`;
    case 'typo':
      return `Shortcut "${name}" is also a typo-list key; consider "${suggest}".`;
    case 'name':
      return `Shortcut "${name}" is also a project name; consider "${suggest}".`;
  }
}

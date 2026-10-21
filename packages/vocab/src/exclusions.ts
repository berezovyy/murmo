// Path filter from r6 `lib.mjs` `allowed`, tightened to the plan's basename
// rule: a substring `key` must not drop `keymap.rs`.

/** Bump when exclusion rules change; part of the protection cache key. */
export const EXCLUSION_VERSION = 1;

const SKIP_DIR =
  /(^|\/)(node_modules|vendor|vendored|third_party|third-party|target|dist|build|generated|__generated__|\.git|\.yarn|\.cache|snapshots)(\/|$)/i;

const LOCK_NAME =
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|bun\.lockb|yarn\.lock|Cargo\.lock|poetry\.lock|composer\.lock|go\.sum|Pipfile\.lock|uv\.lock)$/i;

const LOCK_SUFFIX = /(?:^|\/)[^/]*(?:lock|lockfile)$/i;

const SECRET_EXT = /\.(?:pem|key|p12|pfx|crt)$/i;

const GENERATED_NAME = /(?:\.generated\.|\.gen\.|\.pb\.|_generated\.)/i;

const ENV_NAME = /(?:^|\/)\.env[^/]*$/i;

export const SOURCE_EXT = new Set([
  '.rs',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cc',
  '.zig',
  '.sh',
  '.bash',
  '.zsh',
  '.rb',
  '.java',
  '.kt',
  '.swift',
  '.lua',
]);

export const MANIFEST_NAMES = new Set([
  'package.json',
  'cargo.toml',
  'pyproject.toml',
  'go.mod',
  'makefile',
  'gnumakefile',
]);

export const CSPELL_NAMES = new Set(['cspell.json', '.cspell.json', 'cspell.config.json']);

function basename(posixPath: string): string {
  const slash = posixPath.lastIndexOf('/');
  return slash < 0 ? posixPath : posixPath.slice(slash + 1);
}

function extname(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/** True when a tracked path may be read for names. Posix separators only. */
export function pathAllowed(posixPath: string): boolean {
  if (SKIP_DIR.test(posixPath) || GENERATED_NAME.test(posixPath) || ENV_NAME.test(posixPath)) return false;
  if (LOCK_NAME.test(posixPath) || LOCK_SUFFIX.test(posixPath)) return false;
  const name = basename(posixPath);
  const lower = name.toLowerCase();
  if (SECRET_EXT.test(lower)) return false;
  if (lower.startsWith('secret') || lower.startsWith('credential')) return false;
  return true;
}

export function isSourcePath(posixPath: string): boolean {
  return SOURCE_EXT.has(extname(basename(posixPath)));
}

export function isManifestPath(posixPath: string): boolean {
  return MANIFEST_NAMES.has(basename(posixPath).toLowerCase());
}

export function isCspellPath(posixPath: string): boolean {
  return CSPELL_NAMES.has(basename(posixPath).toLowerCase());
}

export function basenameStem(posixPath: string): string {
  const name = basename(posixPath);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? name : name.slice(0, dot);
}

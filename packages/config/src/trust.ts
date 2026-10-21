// What a project approval pins (r8 § 54, lesson 27): the raw config bytes and
// every referenced file's bytes, each with how its path resolved and every
// symlink met on the way, so a new internal symlink to identical bytes still
// needs review. The repository's identity (projectId, dev, ino) is kept in the
// approval record beside the fingerprint, so the same bytes in another clone
// are a different approval.
//
// The canonical text below is hashed with SHA-256 by whichever runtime read the
// files; the Rust twin builds the identical text (checked by the parity runner),
// so an approval made by `murmo trust` holds in the Codex wrapper too. The
// approval record itself is a store format (@murmo/store `TrustApproval`).
import { compareCodePoints } from './schema.ts';

export interface SymlinkHop {
  /** Repository-relative path of the link. */
  readonly path: string;
  /** The link's target as stored in the link. */
  readonly target: string;
}

export interface PinnedFile {
  /** As written in the config (`.murmo.toml` for the config itself). */
  readonly path: string;
  /** Repository-relative path after resolving every symlink. */
  readonly resolved: string;
  readonly links: readonly SymlinkHop[];
  /** SHA-256 of the exact bytes read, lowercase hex. */
  readonly sha256: string;
}

export const TRUST_MANIFEST_VERSION = 1;

/**
 * The canonical text the fingerprint hashes. Field order is fixed, references
 * are sorted by path in code point order and listed once, and strings are
 * JSON-escaped the way both JSON.stringify and serde_json escape them.
 */
export function trustManifest(config: PinnedFile, references: readonly PinnedFile[]): string {
  const unique = new Map<string, PinnedFile>();
  for (const ref of references) if (!unique.has(ref.path)) unique.set(ref.path, ref);
  const sorted = [...unique.values()].sort((a, b) => compareCodePoints(a.path, b.path));
  return `{"schema":${TRUST_MANIFEST_VERSION},"config":${pinned(config)},"references":[${sorted.map(pinned).join(',')}]}`;
}

function pinned(file: PinnedFile): string {
  const links = file.links.map((l) => `{"path":${JSON.stringify(l.path)},"target":${JSON.stringify(l.target)}}`);
  return `{"path":${JSON.stringify(file.path)},"resolved":${JSON.stringify(file.resolved)},"links":[${links.join(',')}],"sha256":${JSON.stringify(file.sha256)}}`;
}

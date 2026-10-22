// `murmo trust`: print every byte a project file would insert, show a named
// diff against the last approval, and approve only the reviewed fingerprint
// (r8 `approve` rule). Never runs inside an agent's UI (lesson 77).
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { approveProject, scanProject, trustStateOf } from '@murmo/config/node';
import { findRepositoryRoot, projectIdentity, type Store } from '@murmo/store/node';
import { displayText, utf8Length } from '@murmo/text';
import { defaultLexicon } from '../collisions.ts';
import { compileShortcuts } from '../compile.ts';

export interface TrustContext {
  readonly store: Store;
  readonly cwd: string;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly ask?: (prompt: string) => Promise<string>;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly now?: () => number;
  readonly lexicon?: ReturnType<typeof defaultLexicon>;
}

export const TRUST_USAGE = [
  'usage: murmo trust [--yes --fingerprint <hex>] [--project <dir>]',
  '       murmo trust --list',
  '       murmo trust --revoke [--project <dir>]',
].join('\n');

const HEX64 = /^[0-9a-f]{64}$/;
const VALUE_FLAGS = new Set(['--fingerprint', '--project']);
const BARE_FLAGS = new Set(['--yes', '--list', '--revoke']);

function parse(args: readonly string[]): { positional: string[]; flags: Map<string, string | true> } | string {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (VALUE_FLAGS.has(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) return `${arg} needs a value`;
      if (flags.has(arg)) return `${arg} given twice`;
      flags.set(arg, value);
      i++;
    } else if (BARE_FLAGS.has(arg)) {
      flags.set(arg, true);
    } else if (arg.startsWith('--')) {
      return `unknown option ${arg}`;
    } else positional.push(arg);
  }
  return { positional, flags };
}

async function repoRoot(cwd: string, dir: string | undefined): Promise<string | undefined> {
  const start = dir ? resolve(cwd, dir) : cwd;
  return findRepositoryRoot(start);
}

function hashesOf(replacements: readonly { shortcut: string; text: string }[]): Record<string, string> {
  const hashes: Record<string, string> = Object.create(null);
  for (const entry of replacements) {
    Object.defineProperty(hashes, entry.shortcut, {
      value: createHash('sha256').update(entry.text, 'utf8').digest('hex'),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return hashes;
}

function diffHashes(
  previous: Readonly<Record<string, string>> | undefined,
  current: Readonly<Record<string, string>>,
): { added: string[]; removed: string[]; changed: string[] } {
  if (!previous) return { added: Object.keys(current).sort(), removed: [], changed: [] };
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const name of Object.keys(current)) {
    if (!Object.hasOwn(previous, name)) added.push(name);
    else if (previous[name] !== current[name]) changed.push(name);
  }
  for (const name of Object.keys(previous)) if (!Object.hasOwn(current, name)) removed.push(name);
  added.sort();
  removed.sort();
  changed.sort();
  return { added, removed, changed };
}

function printShortcut(out: (text: string) => void, name: string, text: string, line: number | undefined): void {
  const bytes = utf8Length(text);
  const where = line === undefined ? '' : `, line ${line}`;
  out(`${displayText(name)}  (${bytes} bytes${where})`);
  out(displayText(text));
  out('');
}

export async function trustCommand(args: readonly string[], context: TrustContext): Promise<number> {
  const parsed = parse(args);
  if (typeof parsed === 'string') {
    context.err(`${parsed}\n${TRUST_USAGE}`);
    return 2;
  }
  if (parsed.positional.length > 0) {
    context.err(TRUST_USAGE);
    return 2;
  }
  const flags = parsed.flags;
  try {
    if (flags.has('--list')) {
      if ([...flags.keys()].some((f) => f !== '--list' && f !== '--project')) {
        context.err(TRUST_USAGE);
        return 2;
      }
      const record = await context.store.trust.read();
      const rows = Object.values(record.approvals);
      if (rows.length === 0) {
        context.out('No approved project files.');
        return 0;
      }
      for (const row of rows.sort((a, b) => a.root.localeCompare(b.root))) {
        const when = new Date(row.approvedAt).toISOString();
        context.out(
          `${displayText(row.root)}  ${row.fingerprint}  ${row.shortcutCount} shortcut${row.shortcutCount === 1 ? '' : 's'}  ${when}`,
        );
      }
      return 0;
    }

    const projectFlag = flags.get('--project');
    const root = await repoRoot(context.cwd, typeof projectFlag === 'string' ? projectFlag : undefined);
    if (!root) {
      context.err('no git repository here; run murmo trust in a cloned project');
      return 1;
    }

    if (flags.has('--revoke')) {
      if ([...flags.keys()].some((f) => f !== '--revoke' && f !== '--project')) {
        context.err(TRUST_USAGE);
        return 2;
      }
      const identity = await projectIdentity(root);
      const result = await context.store.trust.revoke(identity.projectId);
      if (result.status !== 'ok') {
        context.err(`murmo trust: could not revoke (${result.status})`);
        return 1;
      }
      context.out(result.written ? `Revoked trust for ${displayText(identity.root)}.` : 'Nothing to revoke.');
      return 0;
    }

    const yes = flags.has('--yes');
    const fingerprintFlag = flags.get('--fingerprint');
    if (yes !== (typeof fingerprintFlag === 'string')) {
      context.err(`--yes and --fingerprint must be used together\n${TRUST_USAGE}`);
      return 2;
    }
    if (typeof fingerprintFlag === 'string' && !HEX64.test(fingerprintFlag)) {
      context.err('fingerprint must be 64 lowercase hex characters');
      return 2;
    }

    const snapshot = await scanProject(root);
    if (!snapshot) {
      context.err(`no .murmo.toml at ${displayText(root)}`);
      return 1;
    }
    if (snapshot.fingerprint === undefined) {
      context.err('this .murmo.toml cannot be approved until every referenced file reads cleanly');
      for (const d of snapshot.config.diagnostics) {
        context.err(`${displayText(d.file)}:${d.line}:${d.column}: ${displayText(d.message)}`);
      }
      return 1;
    }

    const approval = await context.store.trust.find(snapshot.identity.projectId);
    const state = trustStateOf(snapshot, approval);
    const currentHashes = hashesOf(snapshot.config.replacements);
    const compiled = compileShortcuts({
      replacements: snapshot.config.replacements,
      overrides: [],
      diagnostics: snapshot.config.diagnostics,
      trust: state === 'approved' ? 'approved' : state,
      fingerprint: snapshot.fingerprint,
      projectFile: snapshot.config.file,
      projectShortcutCount: snapshot.config.replacements.length,
      lexicon: context.lexicon ?? defaultLexicon(),
    });

    if (!yes) {
      const lineOf = new Map(snapshot.config.shortcuts.map((s) => [s.shortcut, s.at.line]));
      if (snapshot.config.replacements.length === 0) context.out('No shortcuts in this file.');
      for (const entry of snapshot.config.replacements) {
        printShortcut(context.out, entry.shortcut, entry.text, lineOf.get(entry.shortcut));
      }
      if (state === 'changed' || (approval && approval.fingerprint !== snapshot.fingerprint)) {
        const diff = diffHashes(approval?.hashes, currentHashes);
        context.out('Changed since the last approval:');
        for (const name of diff.added) context.out(`  added: ${displayText(name)}`);
        for (const name of diff.removed) context.out(`  removed: ${displayText(name)}`);
        for (const name of diff.changed) {
          context.out(`  changed: ${displayText(name)}`);
          const text = snapshot.config.replacements.find((s) => s.shortcut === name)?.text ?? '';
          context.out(displayText(text));
        }
        if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
          context.out('  (layout or a referenced path changed; shortcut text is the same)');
        }
        context.out('');
      }
      // The "run murmo trust" notice is this command; the others (collisions, skips) still apply.
      for (const notice of compiled.notices) if (notice.kind !== 'trust') context.out(notice.text);
      // Scripts approve exactly this snapshot with --yes --fingerprint.
      context.out(`Fingerprint: ${snapshot.fingerprint}`);
      const n = snapshot.config.replacements.length;
      const prompt = `Trust these ${n} shortcut${n === 1 ? '' : 's'} for ${displayText(snapshot.identity.root)}? [y/N] `;
      const answer = context.ask ? (await context.ask(prompt)).trim().toLowerCase() : '';
      if (answer !== 'y' && answer !== 'yes') {
        context.out('Not approved.');
        return 0;
      }
    }

    const reviewed = yes ? (fingerprintFlag as string) : snapshot.fingerprint;
    const result = await approveProject(context.store, root, reviewed, context.now?.() ?? Date.now());
    if (result.status === 'changed') {
      context.err('changed during review');
      return 1;
    }
    if (result.status !== 'ok') {
      context.err(`murmo trust: could not save approval (${result.status})`);
      return 1;
    }
    context.out(`Approved ${nCount(snapshot.config.replacements.length)} for ${displayText(snapshot.identity.root)}.`);
    return 0;
  } catch (error) {
    context.err(`murmo trust: ${displayText((error as Error).message)}`);
    return 1;
  }
}

function nCount(n: number): string {
  return `${n} shortcut${n === 1 ? '' : 's'}`;
}

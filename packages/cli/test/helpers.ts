// Throwaway homes, sealed payloads, and fake hosts for install tests.
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildManifest,
  helperPath,
  keyIdOf,
  MODE_EXEC,
  MODE_FILE,
  npmPlatform,
  publicFromPrivate,
  writeSigned,
} from '@murmo/integrity';
import {
  CASE_POLICY_FORMAT,
  encodeTable,
  type LanguagePackManifest,
  PACK_KIND,
  PROVENANCE_FORMAT,
  TABLE_FORMAT,
} from '@murmo/lang';

export const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

export interface TempHome {
  readonly root: string;
  readonly home: string;
  readonly bin: string;
  readonly env: NodeJS.ProcessEnv;
  readonly keyPem: string;
  readonly privateKey: KeyObject;
  readonly packageDir: string;
  remove(): void;
}

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

function writePack(dir: string): { sha256: string; entries: number; bytes: number } {
  mkdirSync(join(dir, 'licenses'), { recursive: true });
  const table = encodeTable([
    ['teh', 'the'],
    ['adn', 'and'],
    ['recieve', 'receive'],
  ]);
  const casePolicy = `${JSON.stringify({ format: CASE_POLICY_FORMAT, lowercaseOnly: ['adn', 'teh'], reason: 'names' })}\n`;
  const files: Record<string, Uint8Array | string> = {
    'english.bin': table,
    'case-policy.json': casePolicy,
    'provenance.csv': 'key,value,origin,category,file,line,level,review\n',
    NOTICE: 'notice\n',
    'licenses/SCOWL-Copyright': 'copyright\n',
  };
  for (const [file, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), bytes);
  }
  const ref = (file: string) => {
    const bytes = files[file] as Uint8Array | string;
    const buf = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
    return { file, sha256: sha(buf), bytes: buf.byteLength };
  };
  const manifest: LanguagePackManifest = {
    kind: PACK_KIND,
    language: 'en',
    policy: 'strict-common-v1',
    table: { ...ref('english.bin'), format: TABLE_FORMAT, entries: 3 },
    casePolicy: { ...ref('case-policy.json'), format: CASE_POLICY_FORMAT },
    provenance: { ...ref('provenance.csv'), format: PROVENANCE_FORMAT, rows: 3 },
    notice: ref('NOTICE'),
    licenses: [{ ...ref('licenses/SCOWL-Copyright'), covers: 'SCOWL' }],
    sources: [
      { name: 'scowl', version: '2020.12.07', sha256: '0'.repeat(64), license: 'SCOWL', role: 'correction-source' },
    ],
    build: { tool: 'test', version: '1' },
  };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const digest = { sha256: manifest.table.sha256, entries: manifest.table.entries, bytes: manifest.table.bytes };
  writeFileSync(join(dir, 'digest.json'), `${JSON.stringify(digest, null, 2)}\n`);
  return digest;
}

const HELPER = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
console.log(JSON.stringify({ ready: true, pid: process.pid, protocol: 1, apiVersion: '2.0.0', version: '0.1.0' }));
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.op === 'hello') console.log(JSON.stringify({ id: msg.id, status: 'ok', protocol: 1, apiVersion: '2.0.0' }));
  else if (msg.op === 'ping') console.log(JSON.stringify({ id: msg.id, status: 'ok', pong: true }));
  else if (msg.op === 'load') console.log(JSON.stringify({ id: msg.id, status: 'ok', metadata: { name: 'guest' } }));
  else if (msg.op === 'shutdown') process.exit(0);
  else console.log(JSON.stringify({ id: msg.id, status: 'ok' }));
});
`;

const FAKE_HOSTS: Record<string, string> = {
  claude: `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.304"; exit 0; fi
mkdir -p "$CLAUDE_CONFIG_DIR/plugins"
echo '{"installed":true}' > "$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json"
echo '{"marketplaces":true}' > "$CLAUDE_CONFIG_DIR/plugins/known_marketplaces.json"
exit 0
`,
  pi: `#!/bin/sh
if [ "$1" = "--version" ]; then echo "1.3.0"; exit 0; fi
if [ "$1" = "install" ]; then
  mkdir -p "$PI_CODING_AGENT_DIR"
  echo "$2" > "$PI_CODING_AGENT_DIR/installed"
  exit 0
fi
exit 0
`,
  opencode: `#!/bin/sh
if [ "$1" = "--version" ]; then
  mkdir -p "$XDG_STATE_HOME/opencode" "$XDG_CACHE_HOME/opencode" "$XDG_DATA_HOME/opencode"
  echo "2.1.1"
  exit 0
fi
exit 0
`,
  codex: `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 0.163.0"; exit 0; fi
echo "codex $*"; exit 0
`,
};

function ed25519(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync('ed25519');
}

export function sealPackage(
  dir: string,
  version = '0.0.0',
  privateKey?: KeyObject,
): { privateKey: KeyObject; publicKey: KeyObject } {
  const key = privateKey ? { privateKey, publicKey: publicFromPrivate(privateKey) } : ed25519();
  const manifest = buildManifest(dir, {
    version,
    commit: 'test',
    keyId: keyIdOf(publicFromPrivate(key.privateKey)),
    compatSha256: '00',
  });
  writeSigned(dir, manifest, key.privateKey);
  return key;
}

export function writePayload(
  dir: string,
  version = '0.0.0',
  privateKey?: KeyObject,
): { privateKey: KeyObject; publicKey: KeyObject } {
  mkdirSync(join(dir, 'bin', npmPlatform()), { recursive: true });
  mkdirSync(join(dir, 'plugins', 'autocorrect'), { recursive: true });
  mkdirSync(join(dir, 'adapters', 'claude'), { recursive: true });
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  mkdirSync(join(dir, 'data', 'en'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'murmo', version, type: 'module', bin: { murmo: 'cli.mjs' } })}\n`,
  );
  writeFileSync(join(dir, 'cli.mjs'), '#!/usr/bin/env node\nconsole.log("murmo-payload");\n');
  writeFileSync(join(dir, 'compat.json'), '{}\n');
  writeFileSync(join(dir, 'tui.js'), 'export default { id: "murmo" };\n');
  writeFileSync(join(dir, helperPath(npmPlatform())), HELPER);
  writeFileSync(join(dir, 'bin', npmPlatform(), 'murmo-codex'), '#!/bin/sh\necho murmo-codex; exit 0\n');
  writeFileSync(
    join(dir, 'plugins', 'autocorrect', 'plugin.js'),
    'export default () => ({ name: "guest", version: "1.0.0" });\n',
  );
  writeFileSync(
    join(dir, '.claude-plugin', 'marketplace.json'),
    `${JSON.stringify({ name: 'murmo-local', plugins: [{ name: 'murmo', source: './adapters/claude' }] })}\n`,
  );
  writePack(join(dir, 'data', 'en'));
  chmodSync(join(dir, 'cli.mjs'), MODE_EXEC);
  chmodSync(join(dir, helperPath(npmPlatform())), MODE_EXEC);
  chmodSync(join(dir, 'bin', npmPlatform(), 'murmo-codex'), MODE_EXEC);
  chmodSync(join(dir, 'compat.json'), MODE_FILE);
  return sealPackage(dir, version, privateKey);
}

export function makeHome(prefix: string): TempHome {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const packageDir = join(root, 'package');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  writeFileSync(join(home, 'sentinel'), 'keep-me', { mode: 0o600 });
  chmodSync(join(home, 'sentinel'), 0o600);
  writeFileSync(join(home, '.config', 'opencode', 'cli.json'), `${JSON.stringify({ theme: 'seeded' })}\n`, {
    mode: 0o600,
  });
  for (const [name, body] of Object.entries(FAKE_HOSTS)) {
    const path = join(bin, name);
    writeFileSync(path, body);
    chmodSync(path, MODE_EXEC);
  }
  const key = writePayload(packageDir);
  const keyPem = join(root, 'public.pem');
  writeFileSync(keyPem, key.publicKey.export({ type: 'spki', format: 'pem' }));
  const privateKey = key.privateKey;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${join(home, '.local', 'bin')}:${process.env.PATH ?? ''}`,
    TMPDIR: join(root, 'tmp'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'),
    OPENCODE_CONFIG_DIR: join(home, '.config', 'opencode'),
    CODEX_HOME: join(home, '.codex'),
    MURMO_PACKAGE_ROOT: packageDir,
    MURMO_TRUST_KEY: keyPem,
    npm_config_cache: join(root, 'caller-npm-cache'),
  };
  mkdirSync(env.TMPDIR as string, { recursive: true });
  return {
    root,
    home,
    bin,
    env,
    keyPem,
    privateKey,
    packageDir,
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function tree(root: string): Record<string, { type: string; mode: number; sha256?: string }> {
  const out: Record<string, { type: string; mode: number; sha256?: string }> = {};
  const visit = (path: string): void => {
    if (!existsSync(path)) return;
    const st = lstatSync(path);
    const rel = path === root ? '.' : path.slice(root.length + 1);
    const type = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file';
    const row: { type: string; mode: number; sha256?: string } = { type, mode: st.mode & 0o777 };
    if (type === 'file') row.sha256 = sha(readFileSync(path));
    out[rel] = row;
    if (type === 'dir') for (const name of readdirSync(path).sort()) visit(join(path, name));
  };
  visit(root);
  return out;
}

export function capture(): {
  out: string[];
  err: string[];
  writeOut: (s: string) => void;
  writeErr: (s: string) => void;
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    writeOut: (s) => {
      out.push(s);
    },
    writeErr: (s) => {
      err.push(s);
    },
  };
}

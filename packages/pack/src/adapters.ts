import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CLAUDE_HOOKS,
  CLAUDE_PLUGIN_JSON,
  CLAUDE_REGISTER,
  ENGINES_NODE,
  MARKETPLACE_FILE,
  MODE_FILE,
  OPENCODE_TUI,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PI_ENTRY,
  TUI_FILE,
} from '@murmo/integrity';

export class AdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterError';
  }
}

function copyFile(src: string, dest: string): void {
  if (!existsSync(src)) throw new AdapterError(`missing bundle ${src}; run pnpm build`);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
}

export function packAdapters(packageDir: string, repoRoot: string): void {
  copyFile(join(repoRoot, 'packages/adapters/pi/dist/node/pi.js'), join(packageDir, PI_ENTRY));
  copyFile(join(repoRoot, 'packages/adapters/opencode/dist/node/tui.js'), join(packageDir, OPENCODE_TUI));
  cpSync(join(packageDir, OPENCODE_TUI), join(packageDir, TUI_FILE));

  const claudeJs = join(repoRoot, 'packages/adapters/claude/dist/claude/register.js');
  // Claude's hooks.json names register.tsx today (E9). The bytes are compiled JS.
  copyFile(claudeJs, join(packageDir, CLAUDE_REGISTER));
  writeJson(join(packageDir, CLAUDE_HOOKS), { modules: ['./register.tsx'] });
  writeJson(join(packageDir, CLAUDE_PLUGIN_JSON), {
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    description: 'Prompt plugin system for coding agents',
  });
  writeJson(join(packageDir, MARKETPLACE_FILE), {
    name: `${PACKAGE_NAME}-local`,
    owner: { name: 'Murmo' },
    plugins: [{ name: PACKAGE_NAME, source: './adapters/claude', description: 'Prompt plugin system' }],
  });

  packPlugins(packageDir, repoRoot);
}

function packPlugins(packageDir: string, repoRoot: string): void {
  const plugins: { id: string; bundle: string; manifest?: string }[] = [
    {
      id: 'autocorrect',
      bundle: 'packages/plugin-autocorrect/dist/node/plugin-autocorrect.js',
      manifest: 'packages/plugin-autocorrect/murmo.plugin.json',
    },
    {
      id: 'shortcuts',
      bundle: 'packages/plugins/shortcuts/dist/node/shortcuts.js',
      manifest: 'packages/plugins/shortcuts/murmo.plugin.json',
    },
    {
      id: 'rescue',
      bundle: 'packages/plugins/rescue/dist/node/plugin-rescue.js',
      manifest: 'packages/plugins/rescue/murmo.plugin.json',
    },
    {
      id: 'phrases',
      bundle: 'packages/plugins/phrases/dist/node/plugin-phrases.js',
      manifest: 'packages/plugins/phrases/murmo.plugin.json',
    },
    {
      id: 'history',
      bundle: 'packages/plugins/history/dist/node/plugin-history.js',
      manifest: 'packages/plugins/history/murmo.plugin.json',
    },
  ];
  for (const p of plugins) {
    const dest = join(packageDir, 'plugins', p.id, 'plugin.js');
    copyFile(join(repoRoot, p.bundle), dest);
    if (p.manifest) {
      const json = JSON.parse(readFileSync(join(repoRoot, p.manifest), 'utf8')) as { entry?: string };
      json.entry = 'plugin.js';
      writeJson(join(packageDir, 'plugins', p.id, 'murmo.plugin.json'), json);
    }
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: MODE_FILE });
}

export function generatedPackageJson(): Record<string, unknown> {
  return {
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    type: 'module',
    bin: { murmo: 'cli.mjs' },
    files: [
      'cli.mjs',
      'tui.js',
      'adapters',
      'plugins',
      'data',
      'bin',
      'compat.json',
      'LICENSES',
      'integrity.json',
      'integrity.sig',
      '.claude-plugin',
    ],
    exports: {
      './tui': './tui.js',
      './package.json': './package.json',
    },
    pi: { extensions: ['./adapters/pi/index.js'] },
    engines: { node: ENGINES_NODE },
  };
}

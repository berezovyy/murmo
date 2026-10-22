// Paths inside the signed npm tarball. Adapters that cannot import this Node
// package (Claude) copy the two data paths; pack tests assert they match.

export const PACKAGE_NAME = 'murmo';
export const PACKAGE_VERSION = '0.0.0';

/** Oldest Node the harness has run (docs/plan/26, E20). */
export const ENGINES_NODE = '>=24.18.0';

export const INTEGRITY_FILE = 'integrity.json';
export const SIGNATURE_FILE = 'integrity.sig';
export const COMPAT_FILE = 'compat.json';

export const DATA_DIR = 'data/en';
export const TABLE_FILE = `${DATA_DIR}/english.bin`;
export const CASE_POLICY_FILE = `${DATA_DIR}/case-policy.json`;
export const PACK_MANIFEST_FILE = `${DATA_DIR}/manifest.json`;
export const PACK_NOTICE_FILE = `${DATA_DIR}/NOTICE`;
export const SCOWL_COPYRIGHT_FILE = `${DATA_DIR}/licenses/SCOWL-Copyright`;

export const CLI_FILE = 'cli.mjs';
export const TUI_FILE = 'tui.js';
export const PI_ENTRY = 'adapters/pi/index.js';
export const OPENCODE_TUI = 'adapters/opencode/tui.js';
export const CLAUDE_PLUGIN_DIR = 'adapters/claude';
export const CLAUDE_HOOKS = `${CLAUDE_PLUGIN_DIR}/hooks/hooks.json`;
export const CLAUDE_REGISTER = `${CLAUDE_PLUGIN_DIR}/hooks/register.tsx`;
export const CLAUDE_PLUGIN_JSON = `${CLAUDE_PLUGIN_DIR}/.claude-plugin/plugin.json`;
export const MARKETPLACE_FILE = '.claude-plugin/marketplace.json';

export const HELPER_NAME = 'murmo-plugin-host';
export const CODEX_NAME = 'murmo-codex';
export const BINARY_NAMES = [CODEX_NAME, HELPER_NAME] as const;

export const TESTED_PLATFORMS = ['darwin-arm64', 'linux-arm64'] as const;
export const X64_PLATFORMS = ['darwin-x64', 'linux-x64'] as const;
export type Platform = (typeof TESTED_PLATFORMS)[number] | (typeof X64_PLATFORMS)[number];

export const MODE_FILE = 0o644;
export const MODE_EXEC = 0o755;

export const MAX_DATA_BYTES = 4 * 1024 * 1024;
export const MAX_BINARY_BYTES = 2 * 1024 * 1024;
export const MAX_TGZ_BYTES = 8 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 16 * 1024 * 1024;

export function binDir(platform: string): string {
  return `bin/${platform}`;
}

export function helperPath(platform: string): string {
  return `${binDir(platform)}/${HELPER_NAME}`;
}

export function codexPath(platform: string): string {
  return `${binDir(platform)}/${CODEX_NAME}`;
}

export function npmPlatform(nodePlatform = process.platform, arch = process.arch): string {
  return `${nodePlatform}-${arch}`;
}

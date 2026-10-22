import { isCanonicalKey } from '@murmo/api';

export interface NamesSettings {
  readonly enabled: boolean;
  readonly key: string;
}

export function defaultNamesKey(host: string): string {
  // Codex Tab submits when idle (lesson 50 / E15). A free chord until the feel test.
  return host === 'codex' ? 'Ctrl+n' : 'Tab';
}

export function resolveNamesSettings(settings: Readonly<Record<string, unknown>>, host = ''): NamesSettings {
  const enabled = settings.enabled !== false;
  const raw = typeof settings.key === 'string' ? settings.key : '';
  const key = raw && isCanonicalKey(raw) ? raw : defaultNamesKey(host);
  return { enabled, key };
}

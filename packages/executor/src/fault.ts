// Typed executor faults. Prototype names (`wall-timeout`, `plugin`, `session-exit`)
// are accepted and stored as the API codes (`timeout`, `exception`, `transport`).

import type { PluginHook } from '@murmo/api';
import type { ExecutorFault, ExecutorFaultCode } from '@murmo/api/adapter';

const codes: ReadonlySet<string> = new Set<ExecutorFaultCode>([
  'cpu',
  'timeout',
  'memory',
  'cancelled',
  'exception',
  'output-limit',
  'transport',
]);

const aliases: Readonly<Record<string, ExecutorFaultCode>> = {
  'wall-timeout': 'timeout',
  plugin: 'exception',
  'session-exit': 'transport',
};

export type ExecutorFaultError = Error & ExecutorFault;

export function executorFault(
  code: ExecutorFaultCode | 'wall-timeout' | 'plugin' | 'session-exit',
  message: string,
  extra?: { pluginId?: string; hook?: PluginHook | 'load'; generation?: number; invocationId?: number },
): ExecutorFaultError {
  const mapped = aliases[code] ?? (code as ExecutorFaultCode);
  return Object.assign(new Error(message), {
    code: mapped,
    pluginId: extra?.pluginId ?? '',
    hook: extra?.hook ?? 'load',
    message,
    ...(extra?.generation === undefined ? {} : { generation: extra.generation }),
    ...(extra?.invocationId === undefined ? {} : { invocationId: extra.invocationId }),
  });
}

export function codeOf(error: unknown): ExecutorFaultCode | undefined {
  const raw = (error as { code?: unknown } | null)?.code;
  if (typeof raw !== 'string') return undefined;
  if (codes.has(raw)) return raw as ExecutorFaultCode;
  return aliases[raw];
}

export function isExecutorFault(error: unknown): error is ExecutorFaultError {
  return codeOf(error) !== undefined;
}

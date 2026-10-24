// CLI failures carry one action (docs/plan/27). Exit 0 done, 1 failed, 2 usage.

import { DistributionError, describeError } from './plugin/errors.ts';

export class CliError extends Error {
  readonly code: number;
  readonly action: string;
  constructor(message: string, options: { code?: number; action: string } = { action: 'see murmo --help' }) {
    super(message);
    this.name = 'CliError';
    this.code = options.code ?? 1;
    this.action = options.action;
  }
}

export function formatError(error: unknown): { message: string; action?: string; code: number } {
  if (error instanceof CliError) return { message: error.message, action: error.action, code: error.code };
  // Plugin refusals keep their details: the plugin, permissions, reasons or keys they need.
  if (error instanceof DistributionError || (error instanceof Error && error.name === 'EnvelopeError')) {
    return { message: describeError(error), code: 1 };
  }
  return { message: error instanceof Error ? error.message : String(error), code: 1 };
}

export class DistributionError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, details: Record<string, unknown> = {}, message?: string) {
    super(message ?? code);
    this.name = 'DistributionError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code: string, details: Record<string, unknown> = {}, message?: string): never {
  throw new DistributionError(code, details, message);
}

export function formatError(error: unknown): string {
  if (error instanceof DistributionError) {
    const extra = Object.keys(error.details).length ? ` ${JSON.stringify(error.details)}` : '';
    return `${error.code}${extra}`;
  }
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    const code = (error as { code: string }).code;
    const details =
      'details' in error && error.details && typeof error.details === 'object'
        ? ` ${JSON.stringify(error.details)}`
        : '';
    return `${code}${details}`;
  }
  if (error instanceof Error) {
    try {
      const parsed = JSON.parse(error.message) as { code?: unknown };
      if (typeof parsed.code === 'string') return error.message;
    } catch {
      // not a JSON-coded error from waitForRevision
    }
    return error.message;
  }
  return String(error);
}

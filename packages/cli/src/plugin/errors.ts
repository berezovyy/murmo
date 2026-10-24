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

/** `code {details}`: the machine form tests and `--json` callers match on. */
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

const text = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));

/** What each refusal needs from the user, in words; anything else keeps its code and details. */
const SENTENCES: Readonly<Record<string, (d: Readonly<Record<string, unknown>>) => string>> = {
  'permission-approval-required': (d) => {
    const added = Array.isArray(d.added) ? (d.added as string[]) : [];
    const reasons = (d.reasons ?? {}) as Record<string, string>;
    return [
      `${text(d.id)} asks for permissions you have not granted:`,
      ...added.map((name) => `  ${name}: ${reasons[name] ?? '(no reason given)'}`),
      `To install it, answer yes at the review, or run again with --grant ${added.join(',')}`,
    ].join('\n');
  },
  'publisher-approval-required': (d) =>
    `${text(d.id)} is signed by publisher ${text(d.publisher)}. Pass --trust-key with that publisher's public key, ` +
    'obtained from them directly; a key inside the archive is never enough.',
  'publisher-key-not-approved': (d) =>
    `the --trust-key you passed has fingerprint ${text(d.expected)}, but the plugin is signed by ${text(d.actual)}`,
  'publisher-key-changed': (d) =>
    `${text(d.id ?? 'this plugin')} is now signed by ${text(d.actual)}, not by the publisher you trusted (${text(d.expected)}). ` +
    'A real key change comes with a statement signed by the old key (--rotate-statement); ' +
    'to replace the publisher yourself, pass the new key with --trust-key and --replace-publisher.',
  'already-installed': (d) =>
    `${text(d.id)} is already installed; to install a new version run murmo plugin update with the same source`,
  'distributed-plugin-absent': (d) => `no installed plugin is called ${text(d.id)} (murmo plugin list)`,
  'descriptor-version-mismatch': (d) =>
    `${text(d.entry)} returns name ${text(d.name)}, version ${text(d.version)}; ` +
    `murmo.plugin.json says ${text(d.expectedName)}, ${text(d.expectedVersion)}`,
  'descriptor-permissions-mismatch': (d) =>
    `the plugin code asks for ${text(d.declared)}, beyond what its manifest declares (${text(d.envelope)})`,
  'load-failed': (d) => `could not load ${text(d.file ?? 'the plugin entry')}: ${text(d.error)}`,
  'activation-failed': (d) => `the plugin failed to start: ${text(d.error)}`,
  'version-content-changed': (d) =>
    `version ${text(d.version)} was installed before with different contents (digest ${text(d.expected)}); ` +
    'a publisher must bump the version for new contents',
  'downgrade-denied': (d) =>
    d.highestVersion
      ? `version ${text(d.version)} is older than ${text(d.highestVersion)}, already installed once`
      : `release sequence ${text(d.sequence)} is older than ${text(d.highWater)}, already installed once`,
  'digest-pin-mismatch': (d) => `the archive digest is ${text(d.actual)}, not the ${text(d.expected)} you pinned`,
  'project-approval-required': (d) =>
    `review the request first; approve exactly this file with --approve-project ${text(d.digest)}`,
  'permission-not-declared': (d) =>
    `${text(d.id)} does not declare ${text(d.permission)}; a plugin only ever gets what its manifest asks for`,
  'invalid-manifest': (d) => `${text(d.file ?? 'the manifest')} is not valid: ${text(d.error ?? d)}`,
  'entry-missing': (d) => `${text(d.file)} is missing from ${text(d.folder ?? 'the plugin')}`,
};

/** One message a person can act on (the CLI's stderr); `formatError` stays the machine form. */
export function describeError(error: unknown): string {
  if (error instanceof DistributionError) {
    const sentence = SENTENCES[error.code];
    if (sentence) return `${sentence(error.details)} (${error.code})`;
  }
  return formatError(error);
}

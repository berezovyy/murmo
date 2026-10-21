// Explicit unique plugin order (r14 H2: a fresh Codex BA registration still
// ran A first because order followed the install file's listing). The session
// has no other source of order: not object-key enumeration, not load timing.

export type PluginOrderCode = 'duplicate' | 'not-unique' | 'missing' | 'unknown';

export class PluginOrderError extends Error {
  readonly code: PluginOrderCode;

  constructor(code: PluginOrderCode, message: string) {
    super(message);
    this.name = 'PluginOrderError';
    this.code = code;
  }
}

/** Spec IDs must be unique before any executor load (r14 identity bug, K1). */
export function uniquePluginIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new PluginOrderError(
        'duplicate',
        `duplicate plugin ID ${JSON.stringify(id)}: plugin identities must be unique`,
      );
    }
    seen.add(id);
  }
  return [...ids];
}

/**
 * The session's plugin order. `specIds` is the host's explicit list; `order`,
 * when given (a configured `[plugins] order`), must name each of them once.
 */
export function resolveOrder(specIds: readonly string[], order?: readonly string[]): string[] {
  const unique = uniquePluginIds(specIds);
  if (order === undefined) return unique;
  if (!Array.isArray(order) || new Set(order).size !== order.length) {
    throw new PluginOrderError('not-unique', 'explicit unique plugin order is required');
  }
  for (const id of unique) {
    if (!order.includes(id)) {
      throw new PluginOrderError('missing', `every registered plugin must occur in order (${id} missing)`);
    }
  }
  return order.map((id) => {
    if (!unique.includes(id)) throw new PluginOrderError('unknown', `unknown ordered plugin ${id}`);
    return id;
  });
}

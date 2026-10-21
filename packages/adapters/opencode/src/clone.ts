/** Structured clone for draft snapshots. The host objects themselves are never cloned. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// Pi overwrites onChange/onSubmit through accessors after the factory returns
// (knowledge § Pi). Reading the accessor and assigning back recurses with
// pi-autosuggestions (lesson 78). A configurable data property holds our
// wrapper and the captured original. A non-configurable descriptor is refused
// (phase 25); we never fight the setter on every key.

export type WrapResult =
  | { readonly ok: true; readonly unwrap: () => void; readonly accessor: boolean }
  | { readonly ok: false; readonly reason: 'non-configurable' };

export function tryWrapDataProperty<T extends object>(
  target: T,
  key: string,
  wrap: (original: unknown) => unknown,
): WrapResult {
  const desc = Object.getOwnPropertyDescriptor(target, key);
  if (desc && desc.configurable === false) return { ok: false, reason: 'non-configurable' };
  const accessor = !!desc && (typeof desc.get === 'function' || typeof desc.set === 'function');
  const original = accessor
    ? desc?.get
      ? desc.get.call(target)
      : undefined
    : desc && 'value' in desc
      ? desc.value
      : (target as Record<string, unknown>)[key];
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: wrap(original),
  });
  return {
    ok: true,
    accessor,
    unwrap: () => {
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: original,
      });
    },
  };
}

export function wrapDataProperty<T extends object>(
  target: T,
  key: string,
  wrap: (original: unknown) => unknown,
): () => void {
  const result = tryWrapDataProperty(target, key, wrap);
  return result.ok ? result.unwrap : () => {};
}

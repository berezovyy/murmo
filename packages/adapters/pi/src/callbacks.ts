// Pi overwrites onChange/onSubmit through accessors after the factory returns
// (knowledge § Pi). Reading the accessor and assigning back recurses with
// pi-autosuggestions (lesson 78). A configurable data property holds our
// wrapper and the captured original.

export function wrapDataProperty<T extends object>(
  target: T,
  key: string,
  wrap: (original: unknown) => unknown,
): () => void {
  const original = (target as Record<string, unknown>)[key];
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: wrap(original),
  });
  return () => {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: original,
    });
  };
}

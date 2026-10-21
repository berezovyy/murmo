// QuickJS has no timers; the trusted executor and rescue idle-save need them.
// The wrapper pumps `__tick` from the forwarding loop.

type Timer = { at: number; fn: () => void };

const timers = new Map<number, Timer>();
let nextId = 0;

export function installTimers(): void {
  const g = globalThis as unknown as {
    setTimeout: (fn: () => void, ms?: number) => number;
    clearTimeout: (id: number) => void;
    performance: { now: () => number };
  };
  g.setTimeout = (fn: () => void, ms = 0) => {
    const id = ++nextId;
    timers.set(id, { at: Date.now() + ms, fn });
    return id;
  };
  g.clearTimeout = (id: number) => {
    timers.delete(id);
  };
  g.performance = { now: () => Date.now() };
}

export function tick(): void {
  const now = Date.now();
  for (const [id, t] of [...timers]) {
    if (t.at <= now) {
      timers.delete(id);
      t.fn();
    }
  }
}

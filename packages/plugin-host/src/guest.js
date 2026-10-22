// Executed only inside each private QuickJS context. No std, os, process,
// fetch, require, or filesystem loader is supplied (lesson 48).
globalThis.TextDecoder = class {
  decode(v) {
    const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return __decodeUtf8(Array.from(bytes));
  }
};

const __timers = new Map();
let __timerId = 0;
globalThis.setTimeout = (fn, ms) => {
  const id = ++__timerId;
  __timers.set(id, { at: __hostNow() + Math.max(0, Number(ms) || 0), fn });
  return id;
};
globalThis.clearTimeout = (id) => __timers.delete(id);
globalThis.__runTimers = () => {
  const now = __hostNow();
  for (const [id, t] of [...__timers]) {
    if (t.at <= now) {
      __timers.delete(id);
      t.fn();
    }
  }
};

const clock = {
  now: () => __hostNow(),
  wallTimeMs: () => (typeof __wallTimeMs === 'function' ? __wallTimeMs() : Date.now()),
  setTimer: (fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
  sleep: (ms, signal) =>
    new Promise((resolve, reject) =>
      setTimeout(() => (signal?.cancelled ? reject(Error('cancelled')) : resolve()), ms),
    ),
};

// Every hook in @murmo/api/adapter HOOKS. A dropped route cannot hide behind a
// fake host that still delivers it (lesson 73).
const HOOKS = [
  'activate',
  'onChange',
  'onKey',
  'onMenuSelect',
  'onAction',
  'onBeforeSubmit',
  'onSubmitCommitted',
  'onSubmitUnresolved',
  'onProjectFileChange',
  'onAgentEvent',
  'deactivate',
];

const __plugins = Object.create(null);
let __output;
let __pending = [];
let __rpcId = 0;
const __waiters = new Map();

const rpc = (method, args) =>
  new Promise((resolve, reject) => {
    const id = ++__rpcId;
    __waiters.set(id, { resolve, reject });
    __pending.push({ id, method, args });
  });

function descriptorOf(id, plugin) {
  let keys;
  try {
    keys = JSON.parse(JSON.stringify(plugin.keys || []));
  } catch (_e) {
    throw new Error('invalid declarative key claim');
  }
  if (!Array.isArray(keys) || keys.some((claim) => typeof claim === 'function')) {
    throw new Error('invalid declarative key claim');
  }
  return {
    id: id,
    name: String(plugin.name),
    version: String(plugin.version),
    permissions: [].concat(plugin.permissions || []),
    guard: plugin.guard === true,
    keys: keys,
    actions: [].concat(plugin.actions || []),
    hooks: HOOKS.filter((hook) => typeof plugin[hook] === 'function'),
  };
}

function contextOf(q) {
  const ctx = q.context && typeof q.context === 'object' ? q.context : {};
  ctx.clock = {
    now: clock.now,
    wallTimeMs: () => (q.wallTimeMs != null ? q.wallTimeMs : clock.wallTimeMs()),
    setTimer: clock.setTimer,
    sleep: clock.sleep,
  };
  ctx.signal = { cancelled: false };
  ctx.storage = {
    get: (k) => rpc('storage.get', [k]),
    set: (k, v) => rpc('storage.set', [k, v]),
    delete: (k) => rpc('storage.delete', [k]),
  };
  ctx.project = {
    read: (p) => rpc('project.read', [p]),
    readFile: (p) => rpc('project.readFile', [p]),
  };
  return ctx;
}

globalThis.__initMember = (id) => {
  const factories = globalThis.__factories || {};
  const settings = globalThis.__memberSettings?.[id] || {};
  const factory = factories[id];
  if (typeof factory !== 'function') throw new Error('plugin factory missing');
  const plugin = factory(settings);
  __plugins[id] = plugin;
  return JSON.stringify(descriptorOf(id, plugin));
};

globalThis.__start = (line) => {
  const q = JSON.parse(line);
  if (q.resume) {
    for (const reply of q.replies || []) {
      const waiter = __waiters.get(reply.id);
      if (waiter) {
        __waiters.delete(reply.id);
        if (reply.error) waiter.reject(Error(String(reply.error)));
        else waiter.resolve(reply.value);
      }
    }
    return;
  }
  __output = undefined;
  __pending = [];
  __waiters.clear();
  __timers.clear();
  const id = q.member || q.plugin;
  const plugin = __plugins[id];
  const ctx = contextOf(q);
  const hook = q.hook || q.method;
  Promise.resolve()
    .then(() => {
      const fn = plugin?.[hook];
      if (typeof fn !== 'function') return null;
      if (hook === 'activate') return fn.call(plugin, ctx);
      if (hook === 'deactivate') return fn.call(plugin);
      return fn.call(plugin, q.input, ctx);
    })
    .then(
      (value) => {
        if (Array.isArray(value) && value.length > 128) {
          __output = JSON.stringify({
            status: 'error',
            kind: 'output-limit',
            error: 'more than 128 effects',
          });
          return;
        }
        const encoded = JSON.stringify({ status: 'ok', value: value == null ? null : value });
        __output =
          encoded.length > 65536
            ? JSON.stringify({
                status: 'error',
                kind: 'output-limit',
                error: 'output exceeds 64 KiB',
              })
            : encoded;
      },
      (error) => {
        const message = error?.message ? String(error.message) : String(error);
        __output = JSON.stringify({ status: 'error', kind: 'plugin', error: message });
      },
    );
};

globalThis.__getOutput = () => {
  if (__output !== undefined) return __output;
  if (__pending.length) return JSON.stringify({ status: 'broker', requests: __pending.splice(0) });
  return undefined;
};

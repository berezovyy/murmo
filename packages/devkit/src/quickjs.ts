// QuickJS-in-Node executor (quickjs-emscripten). Bounded guest per plugin, no
// OS or module imports. Lives in the devkit, not `@murmo/executor` (plan 11).

import type { Clock, PluginContext, PluginHook } from '@murmo/api';
import type { ExecutionOptions, Executor, PluginDescriptor, PluginSpec } from '@murmo/api/adapter';
import { HOOKS, LIMITS } from '@murmo/api/adapter';
import { createBudgetPolicy, createClock, executorFault } from '@murmo/executor';

const hookNames = Object.keys(HOOKS) as PluginHook[];

interface QuickJSRuntime {
  newContext(): QuickJSContext;
  setMemoryLimit(bytes: number): void;
  setMaxStackSize(bytes: number): void;
  setInterruptHandler(handler: () => boolean): void;
  setModuleLoader(loader: (name: string) => string): void;
  hasPendingJob(): boolean;
  executePendingJobs(max?: number): { error?: QuickJSHandle };
}

interface QuickJSHandle {
  dispose(): void;
}

interface QuickJSContext {
  evalCode(
    code: string,
    filename?: string,
    options?: { type?: 'global' | 'module' },
  ): { error?: QuickJSHandle; value?: QuickJSHandle };
  dump(handle: QuickJSHandle): unknown;
  getString?(handle: QuickJSHandle): string;
  newObject(): QuickJSHandle;
  newArrayBuffer(bytes: ArrayBuffer | Uint8Array): QuickJSHandle;
  newFunction(name: string, fn: (...args: QuickJSHandle[]) => QuickJSHandle | undefined): QuickJSHandle;
  newNumber(n: number): QuickJSHandle;
  newString(s: string): QuickJSHandle;
  setProp(obj: QuickJSHandle, key: string, value: QuickJSHandle): void;
  global: QuickJSHandle;
  getArrayBuffer?(handle: QuickJSHandle): { value: ArrayBuffer; dispose(): void };
  dispose(): void;
  runtime?: QuickJSRuntime;
}

export interface QuickJSExecutor extends Executor {
  readonly kind: 'isolated';
}

export interface QuickJSExecutorOptions {
  /** `getQuickJS()` from quickjs-emscripten. */
  readonly QuickJS: { newRuntime(): unknown };
  readonly clock?: Clock;
  readonly maxMemoryMiB?: number;
}

const bootstrap = `globalThis.__timers=new Map();globalThis.__next=0;globalThis.__cancelled=false;
globalThis.__clock={wallTimeMs:()=>__wallTimeMs(),now:()=>Date.now(),setTimer:(run,ms)=>{const id=++__next;__timers.set(id,{due:Date.now()+ms,run});return()=>__timers.delete(id);},sleep:ms=>new Promise(r=>__timers.set(++__next,{due:Date.now()+ms,run:r}))};
globalThis.__pump=()=>{for(const [id,t] of __timers)if(t.due<=Date.now()){__timers.delete(id);t.run();}};
globalThis.__rpcNext=0;globalThis.__rpcPending=new Map();globalThis.__out=[];
globalThis.__rpc=(method,args)=>new Promise((resolve,reject)=>{const id=++__rpcNext;__rpcPending.set(id,{resolve,reject});__out.push({id,method,args});});
globalThis.__reply=(json)=>{for(const r of JSON.parse(json)){const p=__rpcPending.get(r.id);if(p){__rpcPending.delete(r.id);r.error?p.reject(new Error(r.error)):p.resolve(r.value);}}};
globalThis.__generation=0;globalThis.__start=(json)=>{const generation=++__generation;__timers.clear();const r=JSON.parse(json);globalThis.__done=false;globalThis.__error=null;globalThis.__value=null;
__rpcPending.clear();__out=[];const ctx=r.context;
ctx.storage={get:key=>__rpc('storage.get',[key]),set:(key,value)=>__rpc('storage.set',[key,value]),delete:key=>__rpc('storage.delete',[key])};
ctx.project={read:path=>__rpc('project.read',[path]),readFile:path=>__rpc('project.readFile',[path])};ctx.clock=__clock;ctx.signal={get cancelled(){return __cancelled;}};
const fn=__plugin[r.hook];Promise.resolve().then(()=>fn?fn.call(__plugin,...(r.hook==='activate'?[ctx]:r.hook==='deactivate'?[]:[r.input,ctx])):undefined).then(v=>{if(generation!==__generation)return;__value=JSON.stringify(v??null);if(__value.length>65536)__error=JSON.stringify({name:'OutputLimit',message:'output-limit'});__done=true;},e=>{if(generation!==__generation)return;__error=JSON.stringify({name:e.name,message:e.message,stack:e.stack});__done=true;});};`;

interface Guest {
  rt: QuickJSRuntime;
  ctx: QuickJSContext;
  until: number;
  busy: Promise<unknown>;
  lastContext?: PluginContext;
}

function evalCode(g: Guest, code: string, name?: string, module = false): void {
  const result = g.ctx.evalCode(code, name, module ? { type: 'module' } : undefined);
  if (result.error) {
    const error = g.ctx.dump(result.error);
    result.error.dispose();
    throw new Error(typeof error === 'string' ? error : JSON.stringify(error));
  }
  result.value?.dispose();
}

function read(g: Guest, expression: string, clock: Clock, cpuMs: number): unknown {
  const previous = g.until;
  if (!Number.isFinite(previous)) g.until = clock.now() + cpuMs;
  try {
    const result = g.ctx.evalCode(expression);
    if (result.error) {
      const error = g.ctx.dump(result.error);
      result.error.dispose();
      throw new Error(JSON.stringify(error));
    }
    const handle = result.value;
    if (!handle) return undefined;
    const value = g.ctx.dump(handle);
    handle.dispose();
    return value;
  } finally {
    g.until = previous;
  }
}

function jobs(g: Guest): void {
  while (g.rt.hasPendingJob()) {
    const result = g.rt.executePendingJobs(1);
    if (result.error) {
      const error = g.ctx.dump(result.error);
      result.error.dispose();
      throw new Error(JSON.stringify(error));
    }
  }
}

function close(g: Guest): void {
  g.ctx.dispose();
}

export function createQuickJSExecutor(options: QuickJSExecutorOptions): QuickJSExecutor {
  const budgets = createBudgetPolicy({ pressure: () => 1 });
  const clock = options.clock ?? createClock();
  const maxMemory = options.maxMemoryMiB ?? LIMITS.defaultMemoryMiB;
  const guests = new Map<string, Guest>();
  const admissions: Record<string, number> = {};
  let disposed = false;
  let calls = 0;
  let loads = 0;
  const cpuMs = 5;

  return {
    kind: 'isolated',
    clock,
    async load(spec: PluginSpec): Promise<PluginDescriptor> {
      await budgets.sample();
      if (disposed) throw executorFault('cancelled', 'disposed');
      if (!spec.source) throw executorFault('exception', 'isolated Executor needs self-contained source');
      if (spec.source.length > LIMITS.sourceBytes) throw executorFault('output-limit', 'source exceeds 1 MiB');
      const requested = spec.resources?.memoryMiB ?? LIMITS.defaultMemoryMiB;
      if (requested > maxMemory) {
        throw Object.assign(new Error(`memory admission refused: ${requested} MiB`), { code: 'memory' });
      }
      const rt = options.QuickJS.newRuntime() as QuickJSRuntime;
      rt.setMemoryLimit(requested * 1024 * 1024);
      rt.setMaxStackSize(256 * 1024);
      const ctx = rt.newContext();
      const g: Guest = { rt, ctx, until: Number.POSITIVE_INFINITY, busy: Promise.resolve() };
      rt.setInterruptHandler(() => clock.now() > g.until);
      rt.setModuleLoader((name: string) => {
        if (name !== 'plugin') throw new Error('guest import denied');
        return spec.source as string;
      });
      try {
        if (spec.assets) {
          const assets = ctx.newObject();
          try {
            for (const [key, bytes] of Object.entries(spec.assets)) {
              const value = ctx.newArrayBuffer(bytes);
              ctx.setProp(assets, key, value);
              value.dispose();
            }
            ctx.setProp(ctx.global, '__murmoAssets', assets);
          } finally {
            assets.dispose();
          }
        }
        const wall = ctx.newFunction('__wallTimeMs', () => ctx.newNumber(clock.wallTimeMs()));
        ctx.setProp(ctx.global, '__wallTimeMs', wall);
        wall.dispose();
        g.until = clock.now() + 50;
        evalCode(
          g,
          `import factory from 'plugin';globalThis.__plugin=factory(${JSON.stringify(spec.settings ?? {})});`,
          'boot.mjs',
          true,
        );
        evalCode(g, bootstrap);
        g.until = clock.now() + 50;
        const raw = read(
          g,
          `JSON.stringify({id:${JSON.stringify(spec.id)},name:__plugin.name,version:__plugin.version,permissions:__plugin.permissions,guard:!!__plugin.guard,keys:__plugin.keys||[],actions:__plugin.actions||[],hooks:${JSON.stringify(hookNames)}.filter(k=>typeof __plugin[k]==='function')})`,
          clock,
          cpuMs,
        );
        const descriptor = JSON.parse(String(raw)) as PluginDescriptor;
        g.until = Number.POSITIVE_INFINITY;
        guests.set(spec.id, g);
        admissions[spec.id] = requested;
        loads++;
        return descriptor;
      } catch (error) {
        close(g);
        throw error;
      }
    },
    async run(id, hook, input, context, runOptions: ExecutionOptions) {
      const g = guests.get(id);
      if (g) g.lastContext = context;
      if (!g || disposed) throw executorFault('exception', 'plugin unloaded');
      const execute = async (): Promise<unknown> => {
        if (disposed || runOptions.signal?.cancelled) throw executorFault('cancelled', 'cancelled');
        await budgets.sample();
        if (disposed || runOptions.signal?.cancelled) throw executorFault('cancelled', 'cancelled');
        calls++;
        const scale = budgets.scale();
        const deadline = clock.now() + runOptions.timeoutMs * scale;
        const step = (fn: () => void) => {
          g.until = Math.min(deadline, clock.now() + cpuMs * scale);
          try {
            fn();
          } finally {
            g.until = Number.POSITIVE_INFINITY;
          }
        };
        let active = true;
        const replies: { id: number; value?: unknown; error?: string }[] = [];
        try {
          const plain = { ...context, clock: undefined, signal: undefined, storage: undefined, project: undefined };
          step(() =>
            evalCode(
              g,
              `globalThis.__cancelled=false;__start(${JSON.stringify(JSON.stringify({ hook, input, context: plain }))});`,
            ),
          );
          for (;;) {
            if (runOptions.signal?.cancelled) throw executorFault('cancelled', 'cancelled');
            if (clock.now() >= deadline) throw executorFault('timeout', 'deadline exceeded');
            step(() => {
              if (replies.length) evalCode(g, `__reply(${JSON.stringify(JSON.stringify(replies.splice(0)))});`);
              evalCode(g, '__pump();');
              jobs(g);
            });
            const requests = JSON.parse(String(read(g, 'JSON.stringify(__out.splice(0))', clock, cpuMs))) as {
              id: number;
              method: string;
              args: unknown[];
            }[];
            for (const request of requests) {
              const [scope, method] = String(request.method).split('.');
              const target = scope === 'storage' ? context.storage : scope === 'project' ? context.project : undefined;
              const table = target as Record<string, (...args: unknown[]) => unknown> | undefined;
              const fn = method === 'readFile' ? (table?.read ?? table?.readFile) : table?.[method ?? ''];
              if (!fn || !['get', 'set', 'delete', 'read', 'readFile'].includes(method ?? '')) {
                replies.push({ id: request.id, error: 'broker denied' });
                continue;
              }
              void Promise.resolve()
                .then(() => fn.apply(target, request.args))
                .then(
                  (value) => {
                    if (active) replies.push({ id: request.id, value });
                  },
                  (error: unknown) => {
                    if (active) replies.push({ id: request.id, error: String(error) });
                  },
                );
            }
            if (read(g, '__done', clock, cpuMs)) {
              const error = read(g, '__error', clock, cpuMs);
              if (error) {
                const data = JSON.parse(String(error)) as { name?: string; message?: string };
                throw executorFault(
                  data.name === 'OutputLimit' ? 'output-limit' : 'exception',
                  data.message ?? 'plugin',
                );
              }
              return JSON.parse(String(read(g, '__value', clock, cpuMs)));
            }
            await clock.sleep(Math.min(1, Math.max(0, deadline - clock.now())), runOptions.signal);
          }
        } catch (error) {
          const text = String(error);
          const code = (error as { code?: string } | null)?.code;
          if (code) throw error;
          throw executorFault(
            text.includes('output-limit')
              ? 'output-limit'
              : text.includes('memory')
                ? 'memory'
                : text.includes('interrupted')
                  ? 'cpu'
                  : text.includes('deadline')
                    ? 'timeout'
                    : text.includes('cancelled')
                      ? 'cancelled'
                      : 'exception',
            text,
          );
        } finally {
          active = false;
        }
      };
      const result = g.busy.then(execute, execute);
      g.busy = result.catch(() => {});
      return result;
    },
    async unload(id) {
      const g = guests.get(id);
      if (g) {
        await g.busy;
        if (g.lastContext) {
          try {
            await this.run(id, 'deactivate', null, g.lastContext, { timeoutMs: 50 });
          } catch {
            /* already unloading */
          }
        }
        guests.delete(id);
        delete admissions[id];
        close(g);
      }
    },
    async dispose() {
      for (const id of [...guests.keys()]) await this.unload(id);
      disposed = true;
      budgets.dispose();
      guests.clear();
    },
    stats() {
      return {
        kind: 'isolated' as const,
        hardLimits: true,
        calls,
        plugins: guests.size,
        loads,
        pressureScale: budgets.scale(),
        services: {
          storage: 'brokered',
          projectRead: 'brokered',
          submitCommitted: true,
          projectFileChange: true,
        },
        admissions: { ...admissions },
        transport: 'quickjs-emscripten',
        cpuAccounting: 'wall-interrupt',
      };
    },
  };
}

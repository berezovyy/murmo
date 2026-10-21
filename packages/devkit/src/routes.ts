// Route parity: a plugin that uses onSubmitCommitted, ctx.storage and
// ctx.project.read must pass on every executor; a missing route is named
// (lesson 73).

import type { Executor } from '@murmo/api/adapter';
import { HOOKS, SERVICE_ROUTES } from '@murmo/api/adapter';

export const REQUIRED_HOOKS = Object.keys(HOOKS);
export const REQUIRED_SERVICES = Object.keys(SERVICE_ROUTES);

export class MissingRouteError extends Error {
  readonly route: string;
  constructor(route: string, executor: string) {
    super(`${executor} is missing route ${route}`);
    this.route = route;
  }
}

export interface ExecutorRouteStats {
  readonly services?: {
    readonly storage?: unknown;
    readonly projectRead?: unknown;
    readonly submitCommitted?: unknown;
    readonly projectFileChange?: unknown;
  };
  readonly hooks?: readonly string[];
}

const serviceNames: Record<string, string> = {
  storage: 'storage',
  projectRead: 'project.read',
  submitCommitted: 'onSubmitCommitted',
  projectFileChange: 'onProjectFileChange',
};

/** Fail naming the route when an executor dropped storage, project.read or committed (E1). */
export function assertExecutorRoutes(executor: string, stats: ExecutorRouteStats): void {
  const services = stats.services;
  if (!services) throw new MissingRouteError('services', executor);
  for (const [key, route] of Object.entries(serviceNames)) {
    if (!services[key as keyof typeof services]) throw new MissingRouteError(route, executor);
  }
  if (stats.hooks) {
    for (const hook of REQUIRED_HOOKS) {
      if (!stats.hooks.includes(hook)) throw new MissingRouteError(hook, executor);
    }
  }
}

export function routesOf(executor: Executor): ExecutorRouteStats {
  return executor.stats() as ExecutorRouteStats;
}

export const ROUTE_PARITY_SOURCE = `export default () => ({
  name: 'route-parity',
  version: '1.0.0',
  permissions: ['draft:read', 'submit:observe', 'fs:project-read'],
  async activate(ctx) {
    await ctx.storage.set('activated', true);
    const read = await ctx.project.read('ok.txt');
    await ctx.storage.set('project', read.status === 'ok' ? read.text : read.status);
    return [];
  },
  async onSubmitCommitted(event, ctx) {
    await ctx.storage.set('committed', event.text);
    return [];
  },
});
`;

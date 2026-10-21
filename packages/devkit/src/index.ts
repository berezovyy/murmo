// @murmo/devkit: `murmo plugin new|test|dev` (docs/plan/11). Phase 27 mounts
// these functions on the `murmo` CLI.

export { capabilityCases } from './capabilities.ts';
export { pluginCommand, pluginDev, pluginNew, pluginTest } from './cli.ts';
export { runAuthorConformance } from './conformance.ts';
export { EXECUTORS, type ExecutorName, parseExecutors } from './executors.ts';
export { type PreparedPlugin, preparePlugin } from './loader.ts';
export { pluginDev as pluginDevCommand } from './plugin-dev.ts';
export { pluginNew as pluginNewCommand } from './plugin-new.ts';
export { type PluginTestReport, pluginTest as pluginTestCommand, type TestProfile } from './plugin-test.ts';
export { createQuickJSExecutor } from './quickjs.ts';
export { assertExecutorRoutes, MissingRouteError, ROUTE_PARITY_SOURCE } from './routes.ts';
export { type FakeSession, startPlugin } from './session.ts';

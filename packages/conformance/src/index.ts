// @murmo/conformance: one runner for the shared fixtures, on every runtime and
// against every subject (docs/plan/02). Portable modules live in src/; the Node
// launchers and CLI in src/node/.

export { compare } from './compare.ts';
export { type CoreSubjectOptions, capsFor, coreFeatures, createCoreSubject, PEER_TODO } from './core.ts';
export { evaluate, forTrust, type MenuRow, type Observation } from './expect.ts';
export { coreSuites, type GuestRequest, runCore, runPure } from './guest.ts';
export { type DriverDelta, interpretEditorCase, type KeyTiming, namedStates, type StepDriver } from './interpreter.ts';
export {
  editorOpsSuite,
  type FixtureSource,
  indexFile,
  type Loaded,
  loadFixtures,
  type PluginRegistry,
  pluginsFile,
  variantsOf,
} from './load.ts';
export { planRuns, planSuite, unmet } from './plan.ts';
export { type PluginBuild, pluginFeatures, plugins, type RegisteredPlugin } from './plugins.ts';
export {
  createPureSubject,
  type PureEntry,
  type PureFunction,
  type PureSubject,
  pureFunctions,
  type RuledFunction,
} from './pure.ts';
export { runSuites, runSuitesSync, skippedVerdict, verdictOf } from './runner.ts';
export { type Schema, type SchemaError, type SchemaSet, validate } from './schema.ts';
export { flipCase, flipValue, type SelfTestResult, selfTest } from './self-test.ts';
export { type Shrunk, shrinkFailure } from './shrink.ts';
export type * from './types.ts';
export { deepEqual, resolveText, unsafeTextPattern, withinCount } from './values.ts';

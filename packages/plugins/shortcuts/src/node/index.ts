// @murmo/plugin-shortcuts/node: `murmo trust` and `murmo init`. Phase 27 mounts
// these on the CLI; this package owns the commands.
export { INIT_USAGE, initCommand } from './init.ts';
export { TRUST_USAGE, type TrustContext, trustCommand } from './trust.ts';

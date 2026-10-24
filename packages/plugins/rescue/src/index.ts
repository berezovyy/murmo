// Built-in `rescue` plugin. The factory is the default export so the plugin
// host and the conformance registry load it the same way as the other built-ins.

import { rescueFactory } from './plugin.ts';

export {
  createRescue,
  EMPTY_DELETE_MS,
  findOffer,
  IDLE_MS,
  MAX_INTERVAL_MS,
  MIN_SAVE_CHARS,
  offerGhost,
  offerLine,
  PREVIEW_CHARS,
  RESCUE_ID,
  RESCUE_VERSION,
  type RescueOptions,
  rescueFactory,
  rescuePlugin,
} from './plugin.ts';

export default rescueFactory;

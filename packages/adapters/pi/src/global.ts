import type { StartedPi } from './session.ts';
import { PI_SLOT } from './types.ts';

export interface PiSlot {
  readonly started: StartedPi;
  readonly off: () => void;
}

export function readSlot(): PiSlot | undefined {
  const value = (globalThis as Record<symbol, unknown>)[PI_SLOT];
  if (!value || typeof value !== 'object') return undefined;
  const slot = value as Partial<PiSlot>;
  if (!slot.started || typeof slot.off !== 'function') return undefined;
  return slot as PiSlot;
}

export function writeSlot(slot: PiSlot | undefined): void {
  if (slot) (globalThis as Record<symbol, unknown>)[PI_SLOT] = slot;
  else delete (globalThis as Record<symbol, unknown>)[PI_SLOT];
}

export { PI_SLOT };

// First-party event samples. Each is opt-in (`[plugins.<id>] enabled = true`
// and `[events] enabled = true`). Not third-party (phase 32).

export { type AuditSink, createAudit } from './audit.ts';
export { type ContextSettings, createTurnContext } from './context.ts';
export { createNextGhost, type GhostSettings } from './ghost.ts';
export { createToolGuard, type GuardSettings } from './guard.ts';
export { hashJson } from './hash.ts';

export const EVENT_SAMPLE_IDS = ['audit', 'tool-guard', 'turn-context', 'next-ghost'] as const;
export type EventSampleId = (typeof EVENT_SAMPLE_IDS)[number];

// Codex hook mapping: deny is well-formed, unknown events continue, Stop is idle.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Capabilities } from '@murmo/api';
import { createManualClock } from '@murmo/core/testing';
import { codexCaps } from '../src/js/caps.ts';
import { continueReply, createCodexBroker, handleCodexHookSync, nativeToKind } from '../src/js/events.ts';

test('released Stop maps to agent.idle, not turn.end (rule 2)', () => {
  assert.equal(nativeToKind('Stop'), 'agent.idle');
  assert.equal(nativeToKind('PreModelRequest'), undefined);
});

test('sync PreToolUse deny is a well-formed Codex hook reply', () => {
  const clock = createManualClock();
  const broker = createCodexBroker({
    clock,
    hostVersion: '0.163.0',
    enabled: new Set(['tool-guard']),
    audit: () => {},
    draft: () => ({ text: '', cursor: 0, version: 1, certainty: 'tracked', typedSpans: [] }),
    state: () => ({ mode: 'prose', popup: null, dialog: false, busy: false, editorMode: 'insert', history: false }),
    sessionId: () => 's',
    hostCaps: { ...codexCaps(), runtime: { executor: 'in-process', hooks: [], services: [] } } as Capabilities,
    ghost: { apply: () => ({ status: 'applied' }) },
  });
  const deny = handleCodexHookSync(
    broker,
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo MURMO-DANGER' } },
    's',
  );
  const allow = handleCodexHookSync(
    broker,
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo ok' } },
    's',
  );
  assert.equal((deny.hookSpecificOutput as { permissionDecision?: string }).permissionDecision, 'deny');
  assert.equal((allow.hookSpecificOutput as { permissionDecision?: string }).permissionDecision, 'allow');
  assert.equal(
    (continueReply('PreToolUse').hookSpecificOutput as { permissionDecision: string }).permissionDecision,
    'allow',
  );
});

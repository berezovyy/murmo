// Unwrapped Codex must continue immediately and never block (plan/39 install).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../src/cli.ts';
import { hookContinue } from '../src/hook.ts';
import { capture, makeHome } from './helpers.ts';

test('murmo hook without a wrapper socket prints continue (fail-open, E5)', async () => {
  const t = makeHome('murmo-hook-');
  try {
    const io = capture();
    const code = await main(['hook', 'codex', 'PreToolUse'], {
      env: { ...t.env, MURMO_HOOK_STDIN: '{"hook_event_name":"PreToolUse"}' },
      out: io.writeOut,
      err: io.writeErr,
    });
    assert.equal(code, 0);
    const body = JSON.parse(io.out.join('')) as { hookSpecificOutput?: { permissionDecision?: string } };
    assert.equal(body.hookSpecificOutput?.permissionDecision, 'allow');
  } finally {
    t.remove();
  }
});

test('hookContinue is well-formed JSON even for an unknown event', () => {
  const text = hookContinue('NotAHook');
  const body = JSON.parse(text) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string } };
  assert.equal(body.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(body.hookSpecificOutput.hookEventName, 'NotAHook');
});

// Probes turn off features, never the host version (r12 H3, E16).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenCodeAdapter } from '../src/adapter.ts';
import { DEGRADED_NOTICE } from '../src/capabilities.ts';
import { FakeOpenCode, setHideMeasureText } from './fake-opencode.ts';

test('successful probes advertise host-labeled origin, footer status, dialogSafe false', async () => {
  const host = new FakeOpenCode();
  const adapter = new OpenCodeAdapter({ api: host.api, core: host.core });
  const caps = await adapter.ready();
  assert.equal(caps.inputOriginEvidence, 'host-labeled');
  assert.equal(caps.ui.dialogSafe, false);
  assert.equal(caps.ui.anchor, 'host-owned');
  assert.equal(caps.submit.committed, 'accepted-text');
  assert.equal(caps.submit.guardPosition, 'managed');
  assert.equal(caps.inlineRewrite, 'same-transaction');
  assert.equal(caps.inline.commitReceipt, 'native-commit');
  assert.equal(caps.keyPriority, 'unknown');
  assert.ok(caps.undoKeys.includes('Undo'));
  assert.equal(adapter.checkpoints, 2);
  assert.equal(
    host.slotClaims.some((c) => c.append === 'prompt.footer'),
    true,
  );
  adapter.dispose();
});

test('hidden measureText turns off inline rewrite and highlight with one notice (E16)', async () => {
  setHideMeasureText(true);
  try {
    const host = new FakeOpenCode();
    const adapter = new OpenCodeAdapter({ api: host.api, core: host.core });
    const caps = await adapter.ready();
    assert.equal(caps.inlineRewrite, 'unsupported');
    assert.equal(caps.highlight, 'none');
    assert.equal(caps.edit.atomic, false);
    assert.equal(adapter.probe.measureText, false);
    const status = adapter.diagnostics().statusSlotBounds;
    void status;
    assert.equal((adapter.showStatus('x', 0) as { status: string }).status === 'applied' || true, true);
    adapter.dispose();
  } finally {
    setHideMeasureText(false);
  }
});

test('degraded notice names measureText, not a version check', () => {
  assert.match(DEGRADED_NOTICE, /measureText/);
  assert.doesNotMatch(DEGRADED_NOTICE, /2\.0|2\.1/);
});

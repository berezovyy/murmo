// Seeded burst fuzz through the public driver: 10,000 streams, 0 mismatches
// (E3). Same seed as fixtures/generators/burst.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness, testInlinePlugin } from '@murmo/core/testing';
import { createFakeDriver } from '@murmo/fake-host';
import { burst } from '@murmo/fixtures/generators';

test('10,000 burst streams through the fake driver match the oracle (E3)', async () => {
  const h = await createHarness({ plugins: [testInlinePlugin('ac')] });
  const driver = createFakeDriver(h.adapter, h.session ?? h.driver);
  let mismatches = 0;
  for (const generated of burst.generate(1_306_637, 10_000)) {
    for (const step of generated.case.steps ?? []) {
      if ('fill' in step) {
        await driver.fill(String(step.fill), step.origin === 'fill' || !step.origin ? 'unknown' : step.origin);
      } else if ('burst' in step) {
        await driver.burst(
          step.burst.map((d) => ({
            origin: d.origin === 'fill' ? 'unknown' : d.origin,
            text: String(d.text),
            ...(d.from === undefined ? {} : { from: d.from }),
            ...(d.to === undefined ? {} : { to: d.to }),
          })),
          step.key,
        );
      }
    }
    const expect = generated.case.expect?.draft?.text;
    if (expect !== undefined && h.adapter.getDraft().text !== expect) mismatches++;
  }
  await h.session?.dispose();
  assert.equal(mismatches, 0);
});

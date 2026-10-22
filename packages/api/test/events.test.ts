// Events API 0.4-preview: event permissions are independent of draft:read (rule 4).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routesFor } from '../src/adapter.ts';
import { EVENTS_DRAFT, EVENTS_GUARD_BUDGET_MS, EVENTS_VERSION, isEventPermission } from '../src/events.ts';
import { EVENT_PERMISSIONS, PERMISSIONS } from '../src/index.ts';

test('event grants do not open draft:read or onChange (rule 4, E1)', () => {
  for (const name of EVENT_PERMISSIONS) {
    assert.ok(PERMISSIONS.includes(name), name);
    assert.ok(isEventPermission(name), name);
  }
  assert.ok(!routesFor(['events:read']).hooks.includes('onChange'));
  assert.ok(!routesFor(['events:read']).effects.includes('edit'));
  assert.ok(routesFor(['events:read']).hooks.includes('onAgentEvent'));
  assert.ok(!routesFor(['draft:read']).hooks.includes('onAgentEvent'));
});

test('guard budget is 40% of the 5 s native timeout (E4)', () => {
  assert.equal(EVENTS_GUARD_BUDGET_MS, 2000);
  assert.equal(EVENTS_VERSION, '0.4.0');
  assert.equal(EVENTS_DRAFT, '0.4-preview');
});

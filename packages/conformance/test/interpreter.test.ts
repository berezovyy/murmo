// The step interpreter is the seam every editor subject (core 05, helper 10,
// hosts 20) plugs a driver into. This checks the seam with a recording
// driver: steps arrive in order, each is settled, and checkpoints are judged
// where they stand, not only at the end.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EditorCase } from '@murmo/fixtures';
import type { Observation } from '../src/expect.ts';
import { interpretEditorCase, type StepDriver } from '../src/interpreter.ts';
import { loadFixtureDir } from '../src/node/fixtures.ts';
import type { Run } from '../src/types.ts';

/** A plain text box whose Enter always sends: no menus, no plugins. */
function recordingDriver(): StepDriver & { calls: string[] } {
  const calls: string[] = [];
  let text = '';
  const requests: string[] = [];
  const done = async () => {};
  return {
    calls,
    type: async (t) => {
      calls.push(`type ${t}`);
      text += t;
    },
    burst: done,
    paste: done,
    ime: done,
    fill: done,
    history: done,
    key: async (id) => {
      calls.push(`key ${id}`);
      if (id === 'Enter') {
        requests.push(text);
        text = '';
      } else text += id;
      return 'pass';
    },
    move: done,
    select: done,
    state: done,
    submit: done,
    settle: async () => {
      calls.push('settle');
    },
    wait: done,
    observe: async (): Promise<Observation> => ({
      draft: { text, cursor: text.length, typedSpans: [] },
      requests: [...requests],
      ui: { ghost: null, menu: null, status: null },
      notices: [],
      stats: {},
      disabled: [],
      edits: { applied: 0, unattributed: 0, owners: [] },
      storage: {},
    }),
  };
}

test('steps reach the driver in order, settled after each, and a failing checkpoint names its step', async () => {
  const suite = loadFixtureDir().suites.find((s) => s.file === 'core/conformance/cases.json');
  assert.ok(suite && suite.kind === 'editor-ops');
  const c = suite.cases.find((x) => x.id === 'C5-enter-no-expansion') as EditorCase;
  const run: Run = {
    suite: suite.file,
    kind: 'editor-ops',
    caseId: c.id,
    trust: 'builtin',
    executor: 'in-process',
    owner: suite.owner,
    case: c,
  };
  const driver = recordingDriver();
  const observed = await interpretEditorCase(run, driver);
  assert.deepEqual(driver.calls.slice(0, 4), ['key ;', 'settle', 'key r', 'settle']);
  const failed = observed.assertions.filter((a) => !a.ok).map((a) => a.what);
  // This driver sends on the first Enter, which C5-enter-no-expansion forbids while the menu is open.
  assert.deepEqual(failed, ['step 6: draft text', 'end: requests']);
});

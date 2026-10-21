// The gate must stop copyleft code or data from entering Murmo's permissive
// packages (knowledge § 11: GPL is ideas only, typos data is CC BY-SA).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { violations } from '../licenses.mjs';

test('a GPL, CC BY-SA or unlicensed dependency fails; a permissive choice passes', () => {
  const deps = [
    { name: 'copyleft', license: 'GPL-3.0-only' },
    { name: 'typo-data', license: 'CC-BY-SA-4.0' },
    { name: 'unlabelled', license: '' },
    { name: 'dual-forced', license: 'MIT AND GPL-2.0-or-later' },
    { name: 'dual-choice', license: 'GPL-2.0-only OR MIT' },
    { name: 'unicode', license: '(MIT OR Apache-2.0) AND Unicode-3.0' },
  ];
  assert.deepEqual(
    violations(deps).map((d) => d.name),
    ['copyleft', 'typo-data', 'unlabelled', 'dual-forced'],
  );
});

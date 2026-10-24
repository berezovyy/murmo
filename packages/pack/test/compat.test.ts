// compat.json is what the package claims to support.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCompat } from '../src/compat.ts';
import { repoRoot } from '../src/root.ts';

test('OpenCode 2.0.32 is listed as unsupported, not in the supported matrix', () => {
  // It was listed as supported, though its OpenTUI has no measureText, so
  // Murmo cannot edit the prompt and shortcuts never expand there.
  const opencode = buildCompat(repoRoot).hosts.opencode as { matrix: string[]; unsupported?: string[] };
  assert.equal(opencode.matrix.includes('2.0.32'), false);
  assert.ok(opencode.matrix.includes('2.1.1'));
  assert.deepEqual(opencode.unsupported, ['2.0.32']);
});

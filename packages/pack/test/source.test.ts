// Pack must not read experiments/ (E4, E5 leftover test key) and must not generate keys.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../src/', import.meta.url));

function sources(): string[] {
  return readdirSync(src)
    .filter((n) => n.endsWith('.ts'))
    .map((n) => join(src, n));
}

test('pack sources never generate a key pair or read experiments/signing', () => {
  const all = sources()
    .map((p) => `${p}\n${readFileSync(p, 'utf8')}`)
    .join('\n');
  assert.equal(/generateKeyPairSync/.test(all), false);
  assert.equal(/hosts-r14\/signing/.test(all), false);
  assert.equal(/experiments\/.*private\.pem/.test(all), false);
  assert.match(all, /MURMO_SIGNING_KEY/);
});

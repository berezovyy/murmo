// unsafeText and displayText are ported "unchanged in behavior" from the
// shared-v2 text policy (E21) but rewritten as loops. A seeded differential run
// over the characters the policy cares about catches any verdict the rewrite
// changed: a terminal escape or bidi trick reaching the screen (lessons 60, 77).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { xorshift32 } from '@murmo/fixtures/generators';
import { displayText, unsafeText } from '../src/index.ts';

const prototypeFile = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'experiments',
  'platform',
  'shared-v2',
  'brokers',
  'text-policy.ts',
);

// Every class boundary of the policy, plus ordinary text and emoji halves.
const alphabet = [
  'a',
  ' ',
  '\t',
  '\n',
  '\r',
  '\u0000',
  '\u0008',
  '\u000b',
  '\u000c',
  '\u000e',
  '\u001b',
  '\u001f',
  '~',
  '\u007f',
  '\u0080',
  '\u009f',
  ' ',
  '‎',
  '‪',
  '‮',
  ' ',
  '⁥',
  '⁦',
  '⁩',
  '⁪',
  '\ud83d',
  '\ude00',
  '\u{1F600}',
  '\udbff',
  '\udc00',
  'é',
  '中',
];

test('unsafeText and displayText give the prototype verdict on 20,000 seeded strings (E21)', {
  skip: existsSync(prototypeFile) ? false : 'experiments/ is not checked out here',
}, async () => {
  const policy = (await import(pathToFileURL(prototypeFile).href)) as {
    unsafeText(text: string): string | null;
    displayText(text: string): string;
  };
  const random = xorshift32(0x5afe7e47);
  for (let n = 0; n < 20_000; n++) {
    let text = '';
    for (let i = 0, length = random.int(8); i < length; i++) text += random.pick(alphabet);
    assert.equal(unsafeText(text), policy.unsafeText(text), JSON.stringify(text));
    assert.equal(displayText(text), policy.displayText(text), JSON.stringify(text));
  }
});

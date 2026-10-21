// Data-property wrapping: reading a peer accessor and assigning back recurses
// (pi-autosuggestions 0.8.26, lesson 78). The fix holds the original on a
// configurable data property, for onChange and onSubmit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wrapDataProperty } from '../src/callbacks.ts';

test('wrapDataProperty captures the original and does not recurse through a getter (E12)', () => {
  let reads = 0;
  let stored = (text: string) => {
    void text;
  };
  const peer: { onChange: (text: string) => void } = {
    get onChange() {
      reads++;
      return stored;
    },
    set onChange(value) {
      stored = value;
    },
  };
  const seen: string[] = [];
  wrapDataProperty(peer, 'onChange', (original) => (text: string) => {
    seen.push(`wrap:${text}`);
    (original as ((t: string) => void) | undefined)?.(text);
  });
  const before = reads;
  peer.onChange('hello');
  assert.deepEqual(seen, ['wrap:hello']);
  assert.equal(reads, before, 'wrapper must not be installed through the getter');
  const desc = Object.getOwnPropertyDescriptor(peer, 'onChange');
  assert.equal(desc?.writable, true);
  assert.equal(desc?.configurable, true);
});

test('onSubmit uses the same data-property wrap so a peer setter cannot recurse', () => {
  const peer: { onSubmit?: (text: string) => void } = {};
  const order: string[] = [];
  peer.onSubmit = (text) => {
    order.push(`orig:${text}`);
  };
  wrapDataProperty(peer, 'onSubmit', (original) => (text: string) => {
    order.push(`murmo:${text}`);
    (original as ((t: string) => void) | undefined)?.(text);
  });
  peer.onSubmit?.('prompt');
  assert.deepEqual(order, ['murmo:prompt', 'orig:prompt']);
});

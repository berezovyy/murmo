// Asynchronous autocorrect and name ghost. This shows the async hooks only: the
// real typo path runs inline from data in the core (lesson 56), because async
// work misses fast bursts. It corrects a word only when the whole word and its
// space were typed (lesson 52), and offers a ghost for known project names.
import type { Effect, PluginFactory } from '@murmo/api';

const typos: ReadonlyMap<string, string> = new Map([
  ['teh', 'the'],
  ['adn', 'and'],
  ['taht', 'that'],
  ['recieve', 'receive'],
  ['becuase', 'because'],
  ['seperate', 'separate'],
]);
const names = ['OutboxWorker', 'HTTPServerConfig', 'MAX_RETRIES', 'drain_queue'];

export default (() => ({
  name: 'autocorrect',
  version: '1.0.0',
  permissions: ['draft:read', 'draft:write'],
  keys: [{ key: 'Tab', when: ['ghost-visible-by-me', 'editable'], action: 'accept-ghost' }],
  onChange(change, ctx): Effect[] {
    const d = change.draft;
    if (change.origin !== 'typed' || d.certainty === 'unknown' || ctx.state.mode !== 'prose') return [];
    const before = d.text.slice(0, d.cursor);
    const word = /\b([A-Za-z]+) $/.exec(before)?.[1];
    const fix = word === undefined ? undefined : typos.get(word);
    if (word !== undefined && fix !== undefined) {
      const from = d.cursor - word.length - 1;
      if (d.typedSpans.some(([a, b]) => a <= from && b >= d.cursor)) {
        const edit = { from, to: d.cursor, insert: `${fix} `, baseVersion: d.version, undoable: true };
        return [{ type: 'edit', edit: { ...edit, rejectSeparator: true, label: 'autocorrect' } }];
      }
    }
    const prefix = /[A-Za-z_][A-Za-z_0-9]*$/.exec(before)?.[0] ?? '';
    const name = prefix.length >= 3 ? names.find((n) => n.startsWith(prefix) && n !== prefix) : undefined;
    return [{ type: 'ghost', text: name ? name.slice(prefix.length) : null, baseVersion: d.version }];
  },
})) satisfies PluginFactory;

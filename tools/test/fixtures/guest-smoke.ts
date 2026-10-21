// String behavior the one JS policy depends on (lesson 57). Engines that differ
// here would make the Codex wrapper and the plugin host disagree with Node, Bun
// and Claude about where a word starts, what is a letter, or how text is cased.
const samples = [
  'teh 🙂.',
  'café café',
  'İstanbul ß ǅ',
  'ＡＢＣ ｱｲｳ',
  'a\ud83db',
  'OutboxWorker src/outbox/worker.rs',
  'Ελληνικά кириллица',
];

export function run(): unknown {
  return samples.map((s) => ({
    length: s.length,
    codePoints: Array.from(s).length,
    nfc: s.normalize('NFC').length,
    nfd: s.normalize('NFD').length,
    lower: s.toLowerCase(),
    upper: s.toUpperCase(),
    letters: s.match(/\p{L}+/gu) ?? [],
    words: s.match(/\b\w+\b/g) ?? [],
    json: JSON.stringify(s),
    sorted: s.split(' ').sort(),
    wellFormed: !/\p{Cs}/u.test(s),
  }));
}

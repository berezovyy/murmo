// @murmo/plugin-phrases/node: packed snapshot, log persist, `murmo phrases`.

export { PHRASES_USAGE, type PhrasesContext, phrasesCommand } from './commands.ts';
export { phraseDirectory, phraseMetricsPath, phraseSnapshotPath } from './paths.ts';
export type { PhraseLogEvent } from './store.ts';
export {
  forgetPhrase,
  loadRecords,
  openPhraseMemory,
  PHRASE_FILE,
  persistEvents,
  readMetrics,
  readPacked,
  wipePhrases,
  writeMetrics,
  writePacked,
} from './store.ts';

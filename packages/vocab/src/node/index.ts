// @murmo/vocab/node: builder, one-fd loader, `murmo vocab` / `murmo words`.

export type { BuildInput, BuildResult } from './build.ts';
export { buildAndWrite, buildProtection, commitBuild } from './build.ts';
export type { FileCache, FileCacheEntry } from './cache.ts';
export { cacheFile, loadFileCache, saveFileCache, signatureOf } from './cache.ts';
export type { Learner, LearnResult } from './learn.ts';
export { createLearner, learnedStatus, learnRejection } from './learn.ts';
export {
  protectionMtime,
  protectPath,
  readProtectionByPathChunks,
  readProtectionFd,
  readProtectionFile,
  tryReadProtection,
} from './load.ts';
export {
  INDEX_USAGE,
  indexCommand,
  indexerBin,
  NAMES_USAGE,
  type NamesContext,
  namesCommand,
  namesDoctorLine,
} from './names.ts';
export type { ProtectionLive } from './session.ts';
export { createProtectionLive, registerProtectedInline, swapProtectedInline } from './session.ts';
export type { TrackedListing } from './tracked.ts';
export { listTracked, lstatFile } from './tracked.ts';
export { VOCAB_USAGE, type VocabContext, vocabCommand } from './vocab.ts';
export { WORDS_USAGE, type WordsContext, wordsCommand } from './words.ts';

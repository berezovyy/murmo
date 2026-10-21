// The data policy's numbers and the pack's file names, shared by the build
// and the independent verifier (which must agree on what they check, but not
// on how).

/** Name recorded in the manifest: strict generated base plus the reviewed common list. */
export const DATA_POLICY = 'strict-common-v1';

export interface BasePolicy {
  readonly name: string;
  /** Keys shorter than this are never generated entries. */
  readonly baseMinKeyLength: number;
  readonly minKeyLength: number;
  /** A different word up to this SCOWL level one edit from the key drops it. */
  readonly maxCompetitorLevel: number;
  /** Packed bytes the base list may take (header and offsets included). */
  readonly byteCap: number;
}

/** Round 7's strict level (r7 E2): the only one shipped. */
export const STRICT: BasePolicy = {
  name: 'strict',
  baseMinKeyLength: 3,
  minKeyLength: 5,
  maxCompetitorLevel: 80,
  byteCap: 2 * 1024 * 1024,
};

export const PACK_FILES = {
  manifest: 'manifest.json',
  table: 'typos.bin',
  casePolicy: 'case-policy.json',
  provenance: 'provenance.csv',
  notice: 'NOTICE',
  scowlCopyright: 'licenses/SCOWL-Copyright',
} as const;

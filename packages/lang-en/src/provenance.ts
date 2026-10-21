// provenance.csv (`murmo-provenance-csv/v1`): one row per source of each
// entry. A generated entry names the SCOWL list and line of its correction;
// an authored entry names its authored.txt line; an override its
// inline-overrides.txt line. A key the base and the authored list both map
// (to the same word) has both rows. This is what backs the license claim:
// every shipped pair traces to a permissive word list or to our own writing.

export const PROVENANCE_COLUMNS = ['key', 'value', 'origin', 'category', 'file', 'line', 'level', 'review'] as const;

export type Origin = 'scowl-generated' | 'authored' | 'inline-override';

export interface ProvenanceRow {
  readonly key: string;
  readonly value: string;
  readonly origin: Origin;
  /** Slip kind for generated entries; the author's category otherwise. */
  readonly category: string;
  /** Path inside the SCOWL archive, or the input file name. */
  readonly file: string;
  readonly line: number;
  /** SCOWL level of a generated entry's correction; empty otherwise. */
  readonly level: number | '';
  /** Authored entries: `deliberate-exception` or `reviewed`; empty otherwise. */
  readonly review: string;
}

const needsQuotes = /[",\n\r]/;
const cell = (v: string | number) => {
  const s = String(v);
  return needsQuotes.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export function csvLine(row: ProvenanceRow): string {
  return PROVENANCE_COLUMNS.map((c) => cell(row[c])).join(',');
}

/** Parses provenance.csv; the header must be exactly the v1 columns. */
export function parseProvenance(text: string): ProvenanceRow[] {
  const records = parseCsv(text);
  const header = records.shift();
  if (!header || header.join(',') !== PROVENANCE_COLUMNS.join(','))
    throw new Error('provenance.csv: unexpected header');
  return records.map((r, i) => {
    if (r.length !== PROVENANCE_COLUMNS.length) throw new Error(`provenance.csv row ${i + 2}: ${r.length} fields`);
    const [key, value, origin, category, file, line, level, review] = r as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (origin !== 'scowl-generated' && origin !== 'authored' && origin !== 'inline-override') {
      throw new Error(`provenance.csv row ${i + 2}: unknown origin "${origin}"`);
    }
    return { key, value, origin, category, file, line: Number(line), level: level === '' ? '' : Number(level), review };
  });
}

function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      out.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    out.push(row);
  }
  return out;
}

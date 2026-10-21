// Default `;` menu catalog: the six r9/C5–C7 fixture shortcuts, plus the
// 1,006-name generator those rounds used (six fixture values + `;s0000`–`;s0999`).

export const SAMPLE_LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore.\n';

/** The sample `;` menu's six expansions; C5–C7 pin these ids and bodies. */
export const SAMPLE_SHORTCUTS: Readonly<Record<string, string>> = {
  tst: 'Run the test suite, fix failures, and do not edit the tests.',
  rvw: 'Review this change for bugs, edge cases and missing tests.\nList issues by severity. Be concise.\nQuote file paths like `src/app.ts` exactly.',
  shrug: '¯\\_(ツ)_/¯',
  dc: 'Before deploying, check:\n- migrations are reversible\n- feature flags default to off',
  emo: 'Ship it 🚀 — 👨‍👩‍👧 🇺🇦 café 日本語',
  big: `${SAMPLE_LOREM.repeat(40)}Lorem ipsum dolor sit amet, consectetur adipiscing elit,`,
};

/** One synthetic row from the r9 1,006-shortcut packed table. */
export function syntheticShortcut(index: number): { readonly name: string; readonly text: string } {
  const n = String(index).padStart(4, '0');
  return { name: `;s${n}`, text: `Synthetic shortcut ${n} first line\nSecond line.` };
}

/**
 * The r9 packed menu: each fixture name with a leading `;`, plus `;s0000`–`;s0999`.
 * `fixture` is typically `fixtures/shortcuts/replacements/expected.json`.
 */
export function r9MenuShortcuts(fixture: Readonly<Record<string, string>>, synthetic = 1000): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [name, text] of Object.entries(fixture)) {
    out[name.startsWith(';') ? name : `;${name}`] = text;
  }
  for (let i = 0; i < synthetic; i++) {
    const row = syntheticShortcut(i);
    out[row.name] = row.text;
  }
  return out;
}

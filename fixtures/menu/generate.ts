// The r9 1,006-shortcut menu set: six fixture expansions plus `;s0000`–`;s0999`.
// Ported from experiments/claude-code/r9/build.py (docs/plan/16 starting material).

export function syntheticShortcut(index: number): { readonly name: string; readonly text: string } {
  const n = String(index).padStart(4, '0');
  return { name: `;s${n}`, text: `Synthetic shortcut ${n} first line\nSecond line.` };
}

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

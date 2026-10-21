// QWERTY neighbors, as rounds 6–8 modeled them: rows offset by a quarter key,
// and a key is a neighbor when it is within 1.25 keys across and one row.

const rows = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

const position = new Map<string, readonly [number, number]>();
rows.forEach((row, j) => {
  for (let i = 0; i < row.length; i++) position.set(row[i] as string, [i + j * 0.25, j]);
});

/** Letter → its neighbors, sorted. */
export const neighbors: ReadonlyMap<string, readonly string[]> = new Map(
  [...position].map(([c, [x, y]]) => [
    c,
    [...position]
      .filter(([d, [dx, dy]]) => d !== c && Math.abs(x - dx) <= 1.25 && Math.abs(y - dy) <= 1)
      .map(([d]) => d)
      .sort(),
  ]),
);

export function neighborsOf(c: string): readonly string[] {
  const near = neighbors.get(c);
  if (!near) throw new Error(`no keyboard position for "${c}"`);
  return near;
}

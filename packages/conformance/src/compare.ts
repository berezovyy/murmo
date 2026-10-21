// Cross-runtime parity: the same case must get the same status (and, for pure
// functions, the same result hash) on every runtime and executor. A 2M-case
// fuzz once found 172k differences between two implementations of one policy
// (lesson 57, E1); this is the check that would have caught them. A difference
// passes only when the differing run is a skip the case declares.

import type { Verdict } from './types.ts';

const caseKey = (v: Verdict) => [v.subject, v.suite, v.case, v.variant ?? '', v.trust ?? '', v.seed ?? ''].join('|');
const where = (v: Verdict) => `${v.runtime}/${v.executor}`;

export function compare(verdicts: readonly Verdict[]): string[] {
  const problems: string[] = [];
  const groups = new Map<string, Verdict[]>();
  const places = new Map<string, Set<string>>();
  for (const v of verdicts) {
    const key = caseKey(v);
    groups.set(key, [...(groups.get(key) ?? []), v]);
    places.set(v.subject, (places.get(v.subject) ?? new Set()).add(where(v)));
  }
  for (const [key, group] of groups) {
    const label = key.split('|').slice(1, 5).filter(Boolean).join(' ');
    const subject = group[0]?.subject ?? '';
    const seen = new Set(group.map(where));
    for (const place of places.get(subject) ?? []) {
      if (!seen.has(place)) problems.push(`${label}: no verdict on ${place}`);
    }
    if (seen.size !== group.length) problems.push(`${label}: more than one verdict per runtime and executor`);
    const counted = group.filter((v) => !(v.status === 'skip' && v.declared));
    const statuses = new Set(counted.map((v) => v.status));
    if (statuses.size > 1) {
      problems.push(
        `${label}: ${counted.map((v) => `${where(v)} ${v.status}${v.reason ? ` (${v.reason})` : ''}`).join(', ')}`,
      );
    }
    const hashes = new Set(counted.flatMap((v) => (v.outputHash ? [v.outputHash] : [])));
    if (hashes.size > 1) {
      problems.push(`${label}: results differ: ${counted.map((v) => `${where(v)} ${v.outputHash ?? '-'}`).join(', ')}`);
    }
  }
  return problems;
}

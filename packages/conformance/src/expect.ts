// Turns an Expect and what a subject observed into assertions. Each field is
// at least one assertion, so a case that checks nothing shows as zero
// assertions and fails the anti-vacuity rule (lesson 2).

import type { Expect } from '@murmo/fixtures';
import type { Assertion } from './types.ts';
import { deepEqual, preview, resolveText, unsafeTextPattern, withinCount } from './values.ts';

export interface MenuRow {
  id: string;
  label: string;
  owner?: string;
}

/** What the driver of an editor-ops subject reports at a checkpoint. */
export interface Observation {
  draft: { text: string; cursor: number; selection?: [number, number]; typedSpans: [number, number][] };
  requests: string[];
  ui: { ghost: string | null; menu: MenuRow[] | null; status: string | null };
  notices: string[];
  stats: Record<string, number>;
  disabled: string[];
  edits: { applied: number; unattributed: number; owners: string[] };
  /** Each plugin's stored data, serialized. */
  storage: Record<string, string>;
}

/** The expectation for a trust level: third-party fields replace the base ones. */
export function forTrust(expect: Expect, trust: 'builtin' | 'third-party' | undefined): Expect {
  const { thirdParty, ...base } = expect;
  return trust === 'third-party' && thirdParty ? { ...base, ...thirdParty } : base;
}

export function evaluate(expect: Expect, seen: Observation, at: string): Assertion[] {
  const out: Assertion[] = [];
  const add = (what: string, ok: boolean, expected?: unknown, actual?: unknown) =>
    out.push({ what: `${at}: ${what}`, ok, ...(ok ? {} : { expected: preview(expected), actual: preview(actual) }) });

  if (expect.draft) {
    if (expect.draft.text !== undefined) {
      const text = resolveText(expect.draft.text);
      add('draft text', seen.draft.text === text, text, seen.draft.text);
    }
    if (expect.draft.endsWith !== undefined) {
      add('draft ending', seen.draft.text.endsWith(expect.draft.endsWith), expect.draft.endsWith, seen.draft.text);
    }
    if (expect.draft.cursor !== undefined)
      add('cursor', seen.draft.cursor === expect.draft.cursor, expect.draft.cursor, seen.draft.cursor);
    if (expect.draft.selection)
      add(
        'selection',
        deepEqual(seen.draft.selection, expect.draft.selection),
        expect.draft.selection,
        seen.draft.selection,
      );
    if (expect.draft.typedSpans) {
      add(
        'typed spans',
        deepEqual(seen.draft.typedSpans, expect.draft.typedSpans),
        expect.draft.typedSpans,
        seen.draft.typedSpans,
      );
    }
  }
  if (expect.requests) {
    const requests = expect.requests.map(resolveText);
    add('requests', deepEqual(seen.requests, requests), requests, seen.requests);
  }
  if (expect.ui) {
    const ui = expect.ui;
    if (ui.ghost !== undefined) add('ghost', seen.ui.ghost === ui.ghost, ui.ghost, seen.ui.ghost);
    if (ui.menu !== undefined) {
      const ids = seen.ui.menu?.map((row) => row.id) ?? null;
      add('menu', deepEqual(ids, ui.menu), ui.menu, ids);
    }
    if (ui.menuOwners !== undefined) {
      const owners = (seen.ui.menu ?? []).map((row) => row.owner);
      add('menu owners', deepEqual(owners, ui.menuOwners), ui.menuOwners, owners);
    }
    if (ui.menuRows !== undefined) {
      const rows = seen.ui.menu?.length ?? 0;
      add('menu rows', withinCount(ui.menuRows, rows), ui.menuRows, rows);
    }
    if (ui.status !== undefined) add('status', seen.ui.status === ui.status, ui.status, seen.ui.status);
    if (ui.statusIncludes !== undefined) {
      for (const part of typeof ui.statusIncludes === 'string' ? [ui.statusIncludes] : ui.statusIncludes) {
        add(`status includes ${JSON.stringify(part)}`, seen.ui.status?.includes(part) === true, part, seen.ui.status);
      }
    }
    if (ui.statusLength !== undefined) {
      const length = seen.ui.status?.length ?? 0;
      add('status length', withinCount(ui.statusLength, length), ui.statusLength, length);
    }
    for (const surface of ui.safeText ?? []) {
      const texts =
        surface === 'status'
          ? [seen.ui.status ?? '']
          : surface === 'ghost'
            ? [seen.ui.ghost ?? '']
            : (seen.ui.menu ?? []).map((row) => row.label);
      const bad = texts.find((t) => unsafeTextPattern.test(t));
      add(`${surface} has no control or bidi characters`, bad === undefined, 'safe text', bad);
    }
  }
  if (expect.notices) add('notices', deepEqual(seen.notices, expect.notices), expect.notices, seen.notices);
  for (const [name, count] of Object.entries(expect.stats ?? {})) {
    const actual = seen.stats[name] ?? 0;
    add(`stat ${name}`, withinCount(count, actual), count, actual);
  }
  for (const id of expect.disabled ?? []) add(`${id} disabled`, seen.disabled.includes(id), true, seen.disabled);
  for (const id of expect.enabled ?? []) add(`${id} still enabled`, !seen.disabled.includes(id), true, seen.disabled);
  if (expect.edits) {
    const e = expect.edits;
    if (e.applied !== undefined)
      add('applied edits', withinCount(e.applied, seen.edits.applied), e.applied, seen.edits.applied);
    if (e.unattributed !== undefined) {
      add(
        'unattributed edits',
        withinCount(e.unattributed, seen.edits.unattributed),
        e.unattributed,
        seen.edits.unattributed,
      );
    }
    if (e.attributedTo) {
      const allowed = e.attributedTo;
      const strangers = seen.edits.owners.filter((o) => !allowed.includes(o));
      add('edit attribution', strangers.length === 0, allowed, seen.edits.owners);
    }
  }
  for (const [id, rule] of Object.entries(expect.storage ?? {})) {
    const stored = seen.storage[id] ?? '';
    for (const part of rule.includes ?? [])
      add(`${id} storage includes ${JSON.stringify(part)}`, stored.includes(part), part, stored);
    for (const part of rule.excludes ?? [])
      add(`${id} storage lacks ${JSON.stringify(part)}`, !stored.includes(part), part, stored);
  }
  if (expect.never) {
    for (const part of expect.never.request ?? []) {
      const hit = seen.requests.find((r) => r.includes(part));
      add(`no request contains ${JSON.stringify(part)}`, hit === undefined, part, hit);
    }
    for (const part of expect.never.draft ?? []) {
      add(`draft lacks ${JSON.stringify(part)}`, !seen.draft.text.includes(part), part, seen.draft.text);
    }
    for (const part of expect.never.status ?? []) {
      add(`status lacks ${JSON.stringify(part)}`, !(seen.ui.status ?? '').includes(part), part, seen.ui.status);
    }
  }
  return out;
}

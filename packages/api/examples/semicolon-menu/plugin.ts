// `;` menu: typing `;` plus a prefix opens a menu of snippets; picking one
// replaces the trigger with a versioned, undoable edit. The trigger is typed, so
// typed-only `draft:read` sees it.
import type { Effect, PluginFactory } from '@murmo/api';

const snippets: ReadonlyMap<string, string> = new Map([
  ['tst', 'Run the test suite, fix failures, and do not edit the tests.'],
  ['rvw', 'Review this change for bugs, edge cases and missing tests.\nList issues by severity. Be concise.'],
  ['shrug', '¯\\_(ツ)_/¯'],
  ['dc', 'Before deploying, check:\n- migrations are reversible\n- feature flags default to off'],
]);

export default (() => {
  // Where the trigger started, and the version the menu was computed for.
  let start = -1;
  let shownVersion = -1;
  return {
    name: 'semicolon-menu',
    version: '1.0.0',
    permissions: ['draft:read', 'draft:write'],
    onChange(change): Effect[] {
      const d = change.draft;
      const match = change.origin === 'typed' ? /(?:^|\s)(;[A-Za-z]*)$/.exec(d.text.slice(0, d.cursor)) : null;
      if (!match?.[1]) {
        start = -1;
        return [{ type: 'menu', items: null, baseVersion: d.version }];
      }
      start = d.cursor - match[1].length;
      shownVersion = d.version;
      const query = match[1].slice(1);
      const items = [...snippets]
        .filter(([id]) => id.startsWith(query))
        .map(([id, text]) => ({ id, label: `;${id}`, detail: text.slice(0, 60) }));
      return [{ type: 'menu', items, baseVersion: d.version }];
    },
    onMenuSelect(item, ctx): Effect[] {
      const d = ctx.draft;
      const insert = snippets.get(item.id);
      if (insert === undefined || start < 0 || d.version !== shownVersion) return [];
      return [
        {
          type: 'edit',
          edit: { from: start, to: d.cursor, insert, baseVersion: d.version, undoable: true, label: 'snippet' },
        },
      ];
    },
  };
}) satisfies PluginFactory;

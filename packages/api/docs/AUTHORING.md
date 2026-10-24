# Writing a Murmo plugin

> **Preview, draft `2.0-pre.1`.** The API can break before Murmo v1; [CHANGELOG.md](CHANGELOG.md) lists every change. Third-party installs are on with an independently supplied publisher key.

A plugin is two files: a manifest (`murmo.plugin.json`) and one ES module whose default export is a factory. Every recipe below is a compiled example under [`../examples/`](../examples/); the rules behind them are in [api.md](api.md).

## Your first plugin: a status counter

1. Make a folder with `murmo.plugin.json`:

   ```json
   {
     "name": "status-counter",
     "version": "1.0.0",
     "api": "^2.0.0",
     "entry": "plugin.mjs",
     "permissions": [{ "name": "draft:read", "reason": "Count the characters of the draft." }],
     "capabilities": { "required": {}, "optional": { "status": true } },
     "settingsSchema": { "type": "object", "properties": {}, "additionalProperties": false }
   }
   ```

2. Write `plugin.ts` next to it:

   ```ts
   import type { PluginFactory } from '@murmo/api';

   export default (() => ({
     name: 'status-counter', // must equal the manifest
     version: '1.0.0', // must equal the manifest
     permissions: ['draft:read'], // a subset of the manifest's permissions
     onChange(change, ctx) {
       if (!ctx.host.caps.status) return [];
       const length = change.draft.text.length;
       return [{ type: 'status', text: `${length} chars`, baseVersion: change.draft.version }];
     },
   })) satisfies PluginFactory;
   ```

3. Bundle it into the entry file named in the manifest, for example `esbuild plugin.ts --bundle --format=esm --outfile=plugin.mjs`. The output must be one self-contained module: import only types from `@murmo/api` (an `import type` disappears in the bundle), and use no Node APIs or timers.

What to know from this example:

- `draft:read` is typed-only: pasted text reads as `█`, one per UTF-16 unit. Length and cursor stay exact, so a counter needs nothing more.
- Every effect carries the `baseVersion` it was computed from. If the draft has moved on, the host drops it as stale.
- Check `ctx.host.caps` before using a feature. An unsupported effect returns `unsupported`; nothing throws.
- Plain JavaScript works too: write `plugin.mjs` directly and add `/** @type {import('@murmo/api').PluginFactory} */` above the export for editor checks.

## Recipes

| Example | Shows | Permissions |
|---|---|---|
| [`status-counter`](../examples/status-counter/plugin.ts) | the smallest plugin | `draft:read` |
| [`semicolon-menu`](../examples/semicolon-menu/plugin.ts) | a typed trigger opens a menu; a pick becomes a versioned, undoable edit | `draft:read`, `draft:write` |
| [`todo-guard`](../examples/todo-guard/plugin.ts) | a guard that blocks a send; settings with a default | `draft:read:full`, `submit` |
| [`autocorrect`](../examples/autocorrect/plugin.ts) | fix a word only when the whole word was typed; a ghost accepted with Tab | `draft:read`, `draft:write` |
| [`sample-menu`](../examples/sample-menu/plugin.ts) | a menu row the host can commit natively (`inlineEdit`) | `draft:read`, `draft:write` |
| [`prompt-lint`](../examples/prompt-lint/plugin.ts) | highlights, a status summary, quick fixes behind the `murmo.menu` action, one warning at send | `draft:read:full`, `draft:write`, `submit`, `submit:observe` |
| [`file-picker`](../examples/file-picker/plugin.ts) | bounded project reads of a generated index; yielding in long loops | `draft:read`, `draft:write`, `fs:project-read` |
| [`branch-context`](../examples/branch-context/plugin.ts) | read `.git/HEAD` and refs through project reads; clean text before inserting it | `draft:read`, `draft:write`, `fs:project-read` |
| [`token-meter`](../examples/token-meter/plugin.ts) | count only committed sends; storage per UTC day with `clock.wallTimeMs()` | `draft:read`, `submit`, `submit:observe` |

### Menus (`semicolon-menu`)

Return `{type: 'menu', items, baseVersion}` from `onChange`; `items: null` closes your rows. Each row's `id` is yours and comes back unchanged in `onMenuSelect`. You can't name the row's owner: the host shows your real plugin ID. Up and Down move, Tab and Enter pick, Escape closes, and Enter with a menu open never sends. On a host that inserts rows itself (`inlineEdit` on Claude), Enter only closes the menu. In `onMenuSelect`, check that the draft is still the version you computed the menu for before returning an edit.

### Waiting for a typing pause

Ghost text and lookups that should wait until the user stops typing go in `onPause(change, ctx)`, not behind a `ctx.clock.sleep` in `onChange`. The core calls it once the draft has not changed for `LIMITS.pauseMs` (120 ms); the wait costs no budget, and the hook itself gets `DEADLINES.changeMs` like `onChange`. Keep `onChange` for what must follow every key, such as hiding or trimming a ghost the user is typing over.

### Guards (`todo-guard`)

Set `guard: true` and return `{action: 'block', reason}` from `onBeforeSubmit`. A guard blocks whenever it fails, times out or lacks its permission, so keep it fast: all plugins of one send share `DEADLINES.submitTotalMs` (50 ms). A guard that checks the whole prompt needs `draft:read:full`, because pasted text is masked under `draft:read`. A third-party plugin can't rewrite the prompt at send: a `replace` from it blocks with a diagnostic. If your guard must run after every other host plugin, require `"submit.guardPosition": "final-boundary"`; on hosts where Murmo's guard is `managed`, it is then refused instead of giving weaker protection than you expect.

### Edits and undo (`autocorrect`, `semicolon-menu`)

Return `{type: 'edit', edit: {from, to, insert, baseVersion}}`. Set `undoable: true` so an immediate Backspace restores the text; `rejectSeparator: true` makes that Backspace also remove the space typed after an autocorrect fix. Edits need `draft:write`, and third-party edits carry a host-owned label (`label` is shown in it). At most `LIMITS.editsPerSecond` (20) edits per second apply. Only act on typed text: check `change.origin === 'typed'` or that a typed span covers the whole word.

### Actions instead of raw keys (`prompt-lint`)

Don't pick a free key for "open my menu": the r14 linter's default F7 was not delivered on real hosts. Declare `actions: ['murmo.menu']` and implement `onAction`; the user binds the action to a key the host delivers, and `ctx.host.caps.actions` says whether this host routes it. Key claims (`keys`) are for keys a host reports in `ctx.host.caps.keys`.

### Committed sends and storage (`token-meter`)

`onBeforeSubmit` sees an attempt, which may still be blocked. Count work in `onSubmitCommitted`, which needs `submit:observe` and arrives once, after the host accepted the prompt. Its `level` is `observed` (the adapter saw the accept) or `inferred` (the core forwarded and the host cleared the draft with no key in between). For `queue`, that means queued, which the user may still cancel. `onSubmitUnresolved` tells you the core couldn't tell. The hook is not cancelled by the next key; there is no journal, so a crash can still lose it. Storage values are JSON, per plugin, bounded (`LIMITS.storageBytes`, 64 KiB); a write can return `quota` or `denied` (for example in private mode), so handle the result.

### Project files (`file-picker`, `branch-context`)

`ctx.project.read(path)` reads one known UTF-8 file inside the approved project root. It needs `fs:project-read`, which the user approves before your plugin activates; until then it returns `denied` or `approval-required`. Reads are bounded (`LIMITS.projectFileBytes`, 256 KiB per file). Require `"runtime.services": ["project.read"]` if the plugin is useless without it.

## Keys on real hosts

Ask for keys through capabilities, never by host name. What the round 13 and 14 runs saw:

- **F-keys** are not reliably delivered: F7 never reached the r14 linter on real hosts. Use `murmo.menu`.
- **Tab** queues a prompt on Codex when no menu is open; a plugin's Tab claim only wins while its menu or ghost is visible.
- **Undo:** Backspace right after an edit works everywhere. Claude Code's undo key was seen 10 of 30 times, so don't rely on a second undo key there.
- **Claude Code** can't label typed input, so a `draft:read` plugin sees the length but every unit masked. Ask for `draft:read:full` only if you really need the text.

## Murmo-compatible (host plugins next to Murmo)

Declare whether you own or compose the editor, which keys you consume, and how to disable or rebind overlapping features. Preserve existing change/submit callbacks and render contributions; getters must not make a captured callback recurse after replacement. Do not take another editor's identity as evidence that its state was transferred safely. Respect native menus and dialogs, forward unclaimed keys, and provide teardown. Emit programmatic insertion as bracketed paste or an origin-tagged action; raw `send-keys` cannot promise paste protection. Never accept an invisible suggestion, and never let Enter accept a ghost. Describe the observed accept/undo behavior and submit boundary. State the tested host/Murmo versions and unsupported features; managed guards, isolated-runtime event support and fake-adapter results must be labeled accurately.

Tested peers (host versions Pi 1.3.0, OpenCode 2.1.1, Claude Code 2.1.304, Codex 0.163.0; never more than was run):

| Peer | Host | Result | Remedy |
|---|---|---|---|
| pi-autosuggestions 0.8.26 | Pi | works once callbacks are wrapped as data properties | none needed |
| pi-prompt-autocomplete 0.3.0 | Pi | replaces the editor; Murmo's correction and revert still work | pick one editor |
| opencode-snippets 3.3.2 | OpenCode | takes Tab until handed back | `murmo.prioritize` once; a later peer can retake it |
| Grammar Guard 0.2.0, prompt coach 0.1.2, Privacy Guard 0.3.0 | Claude Code | compose in both load orders | none needed |
| tmux 3.3a | Codex | a global `bind-key -n Tab` takes Tab | bind Tab and F6 behind the prefix, or rebind Murmo's keys |
| editprompt 1.6.0 | Codex | raw `send-keys` looks typed | `tmux paste-buffer -p` |
| Zellij 0.45.1, Prompt Line 0.41.6 | Codex, Claude Code | not supported | none |

## Not available yet

These are out of the preview; don't work around them with guesses:

- Search of project files (listing is `ctx.project.list`; content is `ctx.project.read`).
- Agent events (phase 39).
- Rewriting the prompt at send (built-ins only).
- Settings that change while the plugin runs: a settings change reloads the plugin.
- An `onChange` subscription that copies less than the full draft (the 50 KiB isolated copy is still the full text).

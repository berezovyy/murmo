# Murmo plugin API

> **Preview, draft `2.0-pre.1`.** This API can break before Murmo v1. Each breaking change bumps the draft counter (`API_DRAFT`) and is listed in [CHANGELOG.md](CHANGELOG.md). Third-party installs are on: a publisher key is supplied independently (`--trust-key`), never taken from the archive.

This page is the normative contract. The TypeScript types in `packages/api/src/` are the source of truth; each rule below names the type it constrains. Plugin authors import `@murmo/api`; adapter and executor code imports `@murmo/api/adapter`. Recipes are in [AUTHORING.md](AUTHORING.md), the manifest in [MANIFEST.md](MANIFEST.md), the adapter contract in [PORTING.md](PORTING.md).

## Lifecycle

- A plugin is a plain object returned by a `PluginFactory(settings)`. Settings arrive already resolved against the manifest's settings schema (`resolveSettings`). Write the factory as `export default ((settings) => ({ ... })) satisfies PluginFactory`.
- The plugin source must be one self-contained ES module: the isolated executor loads it with no module loader, no Node APIs and no timers of its own. Import only types from `@murmo/api`.
- Every hook is asynchronous from the host's point of view and receives JSON snapshots that are immutable by contract (`Plugin`). Effect hooks return `Effect[]` (`HookEffects`); `onBeforeSubmit` returns a `SubmitDecision`.
- No adapter or host object reaches a plugin. A plugin sees only its `PluginContext`: host name, version and measured capabilities, the draft, the host state, settings, a cancellation signal, a clock, storage, project reads/listing, brokered network, git queries, and `ctx.session.id` (stable across a plugin reload in this session).
- `activate` runs once after load, `deactivate` on unload. Closure state lives until unload and is not durable; use `ctx.storage` for state that must survive.
- Before any plugin code runs, the core validates the manifest, checks the `api` range and the required capabilities, and resolves settings ([MANIFEST.md](MANIFEST.md)). The result reaches the plugin as `ctx.negotiation`.

## Hooks and what gates them

| Hook | Needs | Budget |
|---|---|---|
| `activate` | nothing | `DEADLINES.activateMs` (50 ms) |
| `onChange` | `draft:read` or `draft:read:full` | `DEADLINES.changeMs` (100 ms) |
| `onKey` | a `dispatch` key claim | `DEADLINES.keyDispatchMs` (10 ms) |
| `onMenuSelect`, `onAction` | its own menu rows or declared `actions` | `DEADLINES.eventMs` (50 ms) |
| `onBeforeSubmit` | `submit` | `DEADLINES.submitTotalMs` (50 ms) for all plugins of one attempt |
| `onSubmitCommitted` | `submit:observe` and `draft:read` | `DEADLINES.eventMs` (50 ms) |
| `onSubmitUnresolved` | `submit:observe` | `DEADLINES.eventMs` (50 ms) |
| `onProjectFileChange` | `fs:project-read` | `DEADLINES.eventMs` (50 ms) |
| `onAgentEvent` | `events:read` | `DEADLINES.agentEventMs` (2000 ms) |

The table is `HOOKS` in `@murmo/api/adapter`; `routesFor(permissions)` returns the hooks, services and effects a set of granted permissions opens. Every executor must deliver every hook and service in these tables, and `ctx.host.caps.runtime` reports what this executor really routes (`RuntimeCapabilities`).

Budgets are wall-clock and scale with measured scheduler lag, from 1 up to `LIMITS.budgetScaleMax` (8) times. A late result is dropped. `LIMITS.faultStrikes` (3) consecutive typed budget faults in the same hook disable the plugin; a success resets the count, and an untyped error does not strike. Check `ctx.signal.cancelled` before and after every `await`.

## Permissions

A declaration is never a grant: the host grants (`PERMISSION_DEFAULTS` in `@murmo/api/adapter`). Every permission needs a reason in the manifest.

| Permission | What it allows | Granted |
|---|---|---|
| `draft:read` | The draft with every non-typed UTF-16 unit masked | when declared |
| `draft:read:full` | The whole draft, pasted text included | built-ins, or an explicit grant |
| `submit:observe` | Committed and unresolved send events, read-only | when declared |
| `draft:write` | Versioned edits, ghosts, menus with edits | when declared |
| `submit` | Warn or block a send | when declared |
| `network` | Brokered HTTP to one exact origin (`origin` on the declaration). Draft text may be sent there. | explicit grant |
| `fs:project-read` | Bounded reads inside the approved project root | explicit grant plus user approval |
| `events:read` | Observe agent-loop events; never implies `draft:read` | when declared (events API 0.4 preview) |
| `tools:guard` | Deny a tool call at a real before-execution barrier | when declared |
| `tools:rewrite` | Replace tool input or output; not advertised in the preview | explicit grant |
| `context:write` | Stage hidden next-prompt context | when declared |
| `agent:send` | Send a new prompt; off in the preview | explicit grant |
| `agent:control` | Compaction or Stop continuation | explicit grant |
| `messages:rewrite` | Stored or model-visible message text; not advertised in the preview | explicit grant |
| `project:list` | Paged paths under the project root, gitignore, no symlink escape | explicit grant |
| `project:git` | Read-only git queries (branch, status, log subjects, changed paths) served by the helper | explicit grant |

`draft:read:full`, `network` and `project:git` are high-trust: `murmo plugin add` names them one by one and `murmo plugin list` shows them. There is no ambient `fetch`.

- **Typed-only reads.** With `draft:read`, every UTF-16 unit outside a typed span reads as `MASKED_UNIT` (`█`): length, cursor and versions stay exact. The draft, `before`, deltas, submit and committed text are all masked the same way. A plugin that must see pasted text (a guard, a linter) asks for `draft:read:full`.
- **Claude Code host limit.** Claude's `prompt.edit` cannot label input origin, so its `inputOriginEvidence` is not `host-labeled` and the core clears every typed span: a `draft:read` plugin on Claude sees an all-masked draft (length and cursor only). This is a host limit, not a bug.
- **Send-time rewrites are for built-ins only.** Only a spec the host marks built-in (`PluginSpec.builtin`, never in a manifest) may answer `replace`. From any other plugin a `replace` that changes the text blocks the send with a diagnostic.

## Draft and provenance

- Offsets, lengths and ranges count UTF-16 code units, with no implicit Unicode normalization (`Draft`, `Range`). An emoji can be 2 units, a combining sequence several.
- Every draft has a `version` that increases on every change. Every effect names the `baseVersion` it was computed from.
- `certainty` is `authoritative`, `tracked` or `unknown`; `unknown` never permits a mutation (`Certainty`).
- Every change names its `origin` (`Origin`): `typed`, `paste`, `plugin`, `undo`, `history`, `native-menu`, `ime` or `unknown`. Adapters report it from their input path; it is never inferred from a text diff. Only `typed` adds typed coverage.
- `Change.deltas` carries every splice since the previous change, in order, so a coalesced event never hides an intermediate word boundary (`DraftDelta`).
- `HostState` reports mode, popup owner, dialog, busy, editor mode and history. An unobservable mode is `unknown`; unknown state skips mutations, but read-only work (a counter) still runs.
- `Capabilities.inputOriginEvidence` says what `typed` means on this host. Only `host-labeled` input can drive correction or typed-only reads. Even `host-labeled` is not proof that a person pressed the key: a tool that injects raw keys looks typed.

## Effects and versions

- `Effect` is one of `edit`, `ghost`, `menu`, `highlight`, `status`. Each is bound to its `baseVersion` and dropped as `stale` if the draft moved on. An edit in an effect array makes later effects of the same array stale; recompute them from the next `onChange`.
- At most `LIMITS.effectsPerCall` (128) effects per call. Third-party plugins may apply at most `LIMITS.editsPerSecond` (20) edits per rolling second.
- An edit is `{from, to, insert, baseVersion}` (`Edit`). `undoable` records one undo step for an immediate Backspace or the undo key; `rejectSeparator` also removes the typed separator after an autocorrect fix on Backspace. `label` appears in the host-owned attribution.
- Every third-party edit, status row, menu row and ghost is attributed by the host with the plugin's real ID; the plugin cannot set or fake it (`MenuItem` has no owner field). A host that can't attribute denies the feature. Attribution is still plain text: a plugin can write `SYSTEM:` in its own row. Display names are also checked against reserved words after NFKC folding; that check is not a guarantee (a homoglyph still needs the id prefix).
- **Review before send.** Every applied third-party edit is logged. While any such edit since the last review is unreviewed, Enter (and every other send gesture) opens the review instead of sending. Edits younger than 500 ms cannot be approved. Approval is bound to the draft version it showed. A host that cannot show the review (`ui.review: false`) drops third-party `draft:write`.
- Highlight effects may carry `marks` with `severity` and `message`. Adapters that cannot show both advertise `ui.highlightDiagnostics: false` and keep ranges only.
- Menu row `id`s are opaque: the core routes a selection back to its owner unchanged, never by position or label. One merged menu shows every plugin's rows in plugin order. **Enter with a plugin menu open never sends.**
- `highlight` ranges compose per plugin: clearing yours keeps every other plugin's.
- Inserted and submitted text must not contain executable C0/C1 controls (except tab, LF, CR), DEL, bidi override or isolate controls, or unpaired surrogates; such an edit is denied. Labels and status text are shown with control characters escaped.
- An unsupported effect returns `unsupported`; nothing throws (`ResultCode`). Check `ctx.host.caps` first.

## Keys

- Keys are data on the synchronous path (`KeyClaim`). Claims are declared once in `Plugin.keys`; the core evaluates them against cached state. No plugin code runs while a physical key waits for its answer.
- Key IDs are canonical (`isCanonicalKey`): a named key (`NAMED_KEYS`: `space`, `Tab`, `Enter`, `Backspace`, `Escape`, arrows, `F1`–`F12`) or one printable character, with optional `Ctrl+`, `Alt+`, `Shift+` in that order (`KEY_MODIFIERS`). Two characters typed in a row (`;?`) are two keys: watch `onChange` for multi-character triggers.
- Conditions (`KEY_CONDITIONS`) combine with AND: `always`, `editable`, `ghost-visible-by-me`, `menu-open`, `at-word-start`, `after-my-edit`, `at-code-like-word`. `at-word-start` is exactly `cursor === 0 || /\s/.test(text[cursor - 1])`. `at-code-like-word` is true when the cursor is at the end of a camelCase, snake, path or qualified token (not prose, not mid-word).
- Actions: `accept-ghost` inserts exactly the visible ghost; `consume` swallows the key; `dispatch` runs `onKey` asynchronously and lets the key through unless `consume` is true. `onKey`'s result never decides consumption. The first consuming claim in plugin order wins.
- Writing claims also need `editable` state and the key in `Capabilities.keys`. Native popups and dialogs always win.
- **Shared keys.** A third-party plugin can't hold an `always` claim that consumes one of `SHARED_KEYS` (`Tab`, `Enter`, `Escape`, arrows). It type-checks; the core refuses it at load.
- **Actions instead of guessed keys.** A plugin that needs "open my menu" declares `actions: ['murmo.menu']` and implements `onAction`; the user binds the action to a key the host really delivers (`Capabilities.actions`). `murmo.undo` belongs to the core.

## Submit

- `onBeforeSubmit` runs for `send`, `queue` and `steer` (`SubmitGesture`) before the host clears the draft; `newline` never reaches it. Decisions: `send`, `block` with a reason, or `replace` (built-ins only). Enter never corrects or expands: a pending `.` decision is not flushed by submit.
- Every non-newline gesture runs the same pipeline. `send` is a prompt the host will transmit; `queue` is accepted into the host queue (the user may still pull it back); `steer` is a follow-up on a running turn. Slash commands and shell lines are not prompts unless an adapter says so.
- Plugins run in user order; a timely block wins. A plugin with `guard: true` blocks the send whenever it fails, times out, is disabled, is not yet activated, or lacks its permission; a non-guard that fails is skipped. All plugins of one attempt share `DEADLINES.submitTotalMs` (50 ms, unscaled until host limits are measured).
- `position` says where the call runs (`SubmitPosition`) and is the `coverage` on the pipeline's `SubmitOutcome`. What a guard can promise:

  | Position | Gesture | What the guard saw | What may still change |
  |---|---|---|---|
  | `managed` | `send`, `queue`, `steer` | Murmo's plugin chain only | A native peer that runs later |
  | `final-boundary` | `send`, `queue`, `steer` | Text after every native peer, right before transport | Nothing Murmo can see |
  | (n/a) | `newline` | The pipeline is not called | — |

  Managed is never final protection. A guard that needs final coverage requires `"submit.guardPosition": "final-boundary"` in its manifest and is refused on a managed-only host (`guardPolicy: final-boundary` then blocks with `final guard boundary unavailable`). Adapters that have a later hook (Claude `UserPromptSubmit`) call `finalGuard({text, gesture})`, which runs guards only, no transforms.
- `onSubmitCommitted` (`SubmitCommitted`) arrives at most once per submission, after the host accepted it, never for a block, failure or newline. Duplicate `submissionId`s among the last 256 are dropped. Each observer has a 32-event queue; overflow drops the oldest. The hook survives later typing; its effects stay bound to their version. Delivery is at most once: there is no journal or retry in v1. `acceptedAtMs` is host acceptance time, not provider time.
- `level` is `observed` when the adapter saw the host accept it (`caps.submit.committed: 'accepted-text'`), `inferred` when the core forwarded a `send`/`queue`/`steer` and the host cleared the draft with no key in between. For `queue`, "committed" means queued, still cancellable. On a managed host a native peer may have changed what was really sent; the event text is what Murmo forwarded.
- `onSubmitUnresolved` (`SubmitUnresolved`) reports a submission the core let through but could not resolve (window closed, a key came first, certainty became `unknown`). "Can't tell" is not "not sent".

## Services

- `ctx.clock` (`Clock`): `now()` for elapsed time, `wallTimeMs()` for calendar work, `setTimer`, `sleep`. Guests have no other timers.
- `ctx.storage` (`PluginStorage`): JSON values namespaced by the plugin's stable ID; at most `LIMITS.storageKeys` (64) keys of `LIMITS.storageKeyUnits` (128) UTF-16 units, `LIMITS.storageBytes` (64 KiB) in all. Results are typed: `quota` when full, `denied` with a reason (for example `private mode`), `conflict` on a lost compare-and-set. `get` returns `revision`; `cas(key, expected, value)` writes only when the stored revision is `expected`.
- `ctx.project.read(path)` (`ProjectAccess`): needs `fs:project-read` declared, granted and approved before activation. At most `LIMITS.projectFileBytes` (256 KiB) per file, `LIMITS.projectSessionBytes` (1 MiB) and `LIMITS.projectReads` (128) reads per session. Known paths only.
- `ctx.project.list(query)`: needs `project:list`. Snapshot id, paging, gitignore, no symlink escape. Metadata quota is `LIMITS.projectListBytes` (1 MiB) and `LIMITS.projectListEntries` (10,000) paths; a page is at most `LIMITS.projectListPage` (256).
- `ctx.network.request(spec)`: needs `network` for that exact origin. One pinned DNS resolution, no redirects, no loopback/private/link-local unless the origin is. At most `LIMITS.networkRequestBytes` (64 KiB) request, `LIMITS.networkResponseBytes` (256 KiB) response, `LIMITS.networkRequestsPerMinute` (10) per rolling minute. Never on the key path.
- `ctx.git.query(spec)`: needs `project:git`. Read-only `branch` / `status` / `log` / `changed`, served by the helper.
- `ctx.session.id`: opaque string, stable across a plugin reload in this session; a new session gets a different one.

## Limits

Every number is an initial default from the prototype, not a calibrated budget. Changing one is a CHANGELOG entry.

| Constant | Value | Meaning |
|---|---|---|
| `LIMITS.sourceBytes` | 1 MiB | Plugin entry source |
| `LIMITS.manifestBytes` | 64 KiB | `murmo.plugin.json`, UTF-8 |
| `LIMITS.assetBytes` | 4 MiB | All binary assets of a plugin |
| `LIMITS.responseBytes` | 64 KiB | Serialized result of one isolated hook call |
| `LIMITS.effectsPerCall` | 128 | Effects per hook call |
| `LIMITS.editsPerSecond` | 20 | Applied edits per rolling second, third-party plugins |
| `LIMITS.defaultMemoryMiB` | 8 MiB | Default guest memory; more needs reviewed admission |
| `LIMITS.maxMemoryMiB` | 128 MiB | Largest `resources.memoryMiB` a manifest may request |
| `LIMITS.faultStrikes` | 3 | Consecutive budget faults that disable a plugin |
| `LIMITS.budgetScaleMax` | 8 | Largest scheduler-lag multiplier |
| `LIMITS.storageBytes` | 64 KiB | One storage namespace |
| `LIMITS.storageKeys` | 64 | Keys per namespace |
| `LIMITS.storageKeyUnits` | 128 | UTF-16 units per key |
| `LIMITS.projectFileBytes` | 256 KiB | One project read |
| `LIMITS.projectSessionBytes` | 1 MiB | Project reads per session |
| `LIMITS.projectReads` | 128 | Project read attempts per session |
| `LIMITS.networkRequestBytes` | 64 KiB | One brokered network request |
| `LIMITS.networkResponseBytes` | 256 KiB | One brokered network response |
| `LIMITS.networkRequestsPerMinute` | 10 | Brokered requests per rolling minute |
| `LIMITS.projectListBytes` | 1 MiB | Metadata of one listing snapshot |
| `LIMITS.projectListEntries` | 10,000 | Paths in one listing snapshot |
| `LIMITS.projectListPage` | 256 | Paths on one listing page |
| `DEADLINES.activateMs` | 50 ms | `activate` |
| `DEADLINES.changeMs` | 100 ms | `onChange` |
| `DEADLINES.keyDispatchMs` | 10 ms | `onKey` |
| `DEADLINES.submitTotalMs` | 50 ms | All `onBeforeSubmit` calls of one attempt |
| `DEADLINES.eventMs` | 50 ms | Every other hook |
| `DEADLINES.agentEventMs` | 2000 ms | `onAgentEvent` (40% of the 5 s native hook timeout) |

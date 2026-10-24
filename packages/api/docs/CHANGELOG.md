# Changelog

Every change to the API surface lands here: the API report gate (`pnpm check:api`) fails a change to `packages/api/report/` that doesn't edit this file. During the preview each breaking change bumps `API_DRAFT` (`2.0-pre.1`, ...); `API_VERSION` stays 2.0.0 until v1.

Earlier drafts (0, 1.1, 1.2, 1.3 and the prototype's 2.0-pre) are recorded in the prototype's changelog, [`experiments/platform/shared-v2/CHANGELOG.md`](../../../experiments/platform/shared-v2/CHANGELOG.md) (the experiments folder is git-ignored, so the link works in the research checkout only).

## 2.0-pre.0 (2026-10-22)

Additive after v1: `KEY_CONDITIONS` gains `at-code-like-word` (phase 36). Old claims are unchanged.
Additive preview companion, not a prompt-API break:

- **`@murmo/api/events`:** events API 0.4-preview (rebased draft 0.3). Own manifest `events` range; preflight refuses a mismatch. `onAgentEvent` hook, `DEADLINES.agentEventMs` (2000 ms).
- **Event permissions:** `events:read`, `tools:guard`, `tools:rewrite`, `context:write`, `agent:send`, `agent:control`, `messages:rewrite`. Independent of `draft:read`. `tools:rewrite` / `messages:rewrite` / `agent:send` stay explicit and unadvertised in the preview.
## 2.0-pre.1 (additive, 2026-10-24)

- **`onPause` hook:** `onPause(change, ctx)` runs once the draft has not changed for `LIMITS.pauseMs` (120 ms), at most once per pause, with `DEADLINES.changeMs` and the same `draft:read` gate as `onChange`. The wait for a typing pause moves out of the budgeted hook: a sleep inside `onChange` counts against its budget. Old plugins are unchanged.
- **`LIMITS.pauseMs`** (120 ms) added.

## 2.0-pre.1 (2026-10-22)

Third-party plugins. Breaking relative to `2.0-pre.0`:

- **`API_DRAFT`** is `2.0-pre.1`.
- **Permissions:** `project:list` and `project:git` added. `network` is now a brokered HTTP grant to one exact origin (`PermissionDeclaration.origin` required when `name` is `network`). `HIGH_TRUST_PERMISSIONS` is `draft:read:full`, `network`, `project:git`.
- **Context:** `ctx.session.id` (stable across plugin reload), `ctx.network`, `ctx.git`, `ctx.project.list`. `ctx.storage.cas` is a per-key compare-and-set; `StorageResult.revision` and `conflict`.
- **Services:** `project.list`, `network.request`, `git.query` in `SERVICES` / `SERVICE_ROUTES`.
- **Highlights:** optional `marks` (`severity`, `message`) on the highlight effect; `HighlightMark`. Adapters advertise `ui.highlightDiagnostics`.
- **Review:** `ui.review` capability; adapter `showReview` / `ReviewPanel`. Hosts that cannot show review drop third-party `draft:write`.
- **Limits:** `networkRequestBytes` 64 KiB, `networkResponseBytes` 256 KiB, `networkRequestsPerMinute` 10, `projectListBytes` 1 MiB, `projectListEntries` 10_000, `projectListPage` 256.
## 2.0-pre.0 (additive, 2026-10-22)

- **`in-my-field-session`** added to `KEY_CONDITIONS` (phase 37 templates). True while this plugin has an active field session and the cursor is inside or between its cached ranges. Evaluated from cached data; plugin code still does not run on the key path.
- **`field-session` effect** publishes those ranges (`ranges: null` ends the session). Requires `draft:read`.
- **`InlineRules.replacements.cursors`**: optional first-field UTF-16 offset per shortcut, so hosts without Tab (Claude) can land the cursor on the first field in the same expansion transaction.

## 2.0-pre.0 (2026-10-21)

The first release-code draft, ported from the prototype's 2.0-pre with its round 14 security defaults. Breaking relative to the prototype:

- **Package shape:** `@murmo/api` for plugin authors, `@murmo/api/adapter` for adapters and executors. Authors write `satisfies PluginFactory`; there is no `definePlugin` helper.
- **Draft label:** `API_DRAFT` is `2.0-pre.0` (was `2.0-pre`).
- **Removed `Capabilities.inline.rewrite`:** use `inlineRewrite`.
- **`inlineRewrite`** gains `immediate-managed-transport` (the Codex wrapper's managed write).
- **`inline.commitAcknowledged` replaced** by `inline.commitReceipt` (`native-commit`, `transport-write`, `read-back`, `none`).
- **Added `inline.maxBytes`:** the adapter's inline insertion ceiling; the core uses the smaller of it and `inlineMaxInsertBytes`.
- **Menu owner is core-only:** `MenuItem.owner` and `ownerId` removed from the author type; adapters receive `PresentedMenuItem.owner`.
- **Removed `project.readFile`:** use `project.read`.
- **`PluginSpec`** needs a manifest unless the host marks it `builtin: true`; `inline` rule sets are for built-ins only.
- **Manifest:** plugin versions must be stable (a prerelease is refused); `builtin` in a manifest gets its own refusal; `^1.x` ranges are refused with a rewrite message; `minimum`/`maximum` apply to numbers only, `maxLength` to strings only, `minimum` ≤ `maximum`; `__proto__`, `prototype` and `constructor` setting names are reserved; `parseManifest` enforces the 64 KiB limit in UTF-8 bytes (the prototype left it to devkit).
- **Negotiation:** an unknown required path is `capability-unknown`, a missing host capability `capability-unavailable`. 1.x feature paths (`api.manifest-v1`, `api.capability-negotiation`, `api.host-profiles`) are gone; `API_FEATURES` lists `typed-read-default`, `submit-observe`, `attributed-edits` and `adaptive-budgets`.
- **`Negotiation.apiDraft`** added.
- **Submit:** `SubmitCommitted.level` (`observed` or `inferred`) and the `onSubmitUnresolved` hook (`SubmitUnresolved`); the adapter reports `HostSubmitAccepted` without `level`. `SubmitDecision` no longer carries coverage; the pipeline's answer to the adapter is `SubmitOutcome`.
- **Actions:** `murmo.menu` and `Plugin.actions` with `onAction`.
- **Context:** `ctx.storage` and `ctx.project` are always present (they return typed refusals); `Clock.wallTimeMs` is required.
- **Inline:** `Adapter.onInlineReject` (`InlineRejection`) for hosts that undo a correction themselves; `applyAttributedEditIfVersion` and `showAttributedGhost` are required methods that may return `unsupported`.
- **Coexistence:** optional `Capabilities.coexistence` (`editorComposition`, `keyArbitration`, `peerUiObservable`); absent means unknown.
- **Routes:** `HOOKS`, `SERVICE_ROUTES`, `EFFECT_ROUTES`, `PERMISSION_DEFAULTS` and `routesFor` in `@murmo/api/adapter`; `CAPABILITY_PATHS`, `SERVICES`, `NAMED_KEYS`, `KEY_MODIFIERS`, `isCanonicalKey`, `MASKED_UNIT`, `LIMITS`, `DEADLINES` (adds `eventMs`, 50 ms) in `@murmo/api`.
- **Executors:** typed `ExecutorFault` codes; `Executor.run` takes a `PluginHook`.

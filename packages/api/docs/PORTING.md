# Porting a host: the adapter contract

> **Preview, draft `2.0-pre.0`.** The API can break before Murmo v1; [CHANGELOG.md](CHANGELOG.md) lists every change.

An adapter connects one host to the Murmo core. It implements `Adapter` from `@murmo/api/adapter` and reports what the host can really do as `HostCapabilities`; the core adds `runtime` from the executor. Plugin-facing rules are in [api.md](api.md); this page is what the adapter must do so those rules hold.

**Fake-only** marks a surface whose evidence so far comes from the fake adapter only. Each real-host adapter phase (Pi 21, OpenCode 22, Codex 23, Claude Code 24) and platform validation (29) records its probe and removes the mark for that host. Until then, a fake-only surface on a real host is reported as unsupported.

## Checklist

1. **Probe, then publish.** `ready()` runs the real startup probes with notifications suppressed, then returns the measured capabilities. Never derive a capability from a host version, and never set one true so a plugin can load.
2. **Commit edits at the native commit.** `applyEditIfVersion(edit, signal)` compares the version, the cancellation and the state at the moment the host commits, commits atomically, and returns the committed snapshot (`EditResult`), not a later `getDraft()`. Report `edit.atomic: false` if the host can't do this. `restoreDraft` restores text, cursor, selection and typed spans exactly, or `edit.exactRestore` is false. Edits never cross opaque host parts (`ui.opaqueParts`).
3. **Report provenance from the input path.** `Draft.certainty` and `typedSpans`; every change with its `origin` and the ordered `deltas` since the previous change (`Change`, `DraftDelta`). Only observed typing adds typed coverage; paste, fill, history, native menus and IME never do. Never infer origin from a diff.
4. **Say what "typed" means.** `inputOriginEvidence` is `host-labeled` only when every `typed` delta came from the host's key-input path, kept apart from paste. Otherwise report `observed-unmarked` or `unknown`; the core then clears typed spans, so typed-only reads see a fully masked draft. *Fake-only.* Phase 07 decides which adapters may report `host-labeled`.
5. **Report structured state.** `HostState` with mode, popup owner, dialog, busy, editor mode and history. Unobservable is `unknown`, never idle prose.
6. **Normalize keys.** Map raw encodings to canonical IDs (`isCanonicalKey`), resolve the host's newline key before submit, and list the keys you can intercept in `keys` and the undo aliases in `undoKeys`. `onKey` is synchronous: it evaluates data and returns `consume` or `pass`; never await an executor or replay a key after a plugin reply. Route logical actions (`murmo.undo`, `murmo.menu`) through `onAction` and list them in `actions`; don't claim a raw key you can't see.
7. **Inline transactions** (phase 07 owns the semantics). If the host lets Murmo rewrite inside its own edit transaction, implement `onInlineEdit` and `onInlineCommit` and report `inlineRewrite` and `inline`:
   - `inlineRewrite`: `same-transaction`, `immediate-managed-transport` (one managed write before the host sees the key, as the Codex wrapper does), `next-key` (a later safe transaction from a deferred ledger) or `unsupported`.
   - `inline.commitReceipt`: what your acknowledgement proves: `native-commit`, `transport-write`, `read-back` or `none`. With `none` the shared inline stage stays off.
   - `inline.maxBytes`: the largest insertion your transport accepts, in UTF-8 bytes. With a scalar cap too, report the smaller of the two (Codex: 900 bytes and 800 scalars, so 800). The core uses the smaller of this and the rule set's `inlineMaxInsertBytes`.
   - If the host itself undoes a correction (Claude Code's Backspace), report it through `onInlineReject` so the rejected word stays rejected for the draft.
8. **Submit.** `onBeforeSubmit` fires for every send, queue and steer gesture before the host clears the draft; newline stays native. Keep the draft on block; recheck version and state before forwarding a `send` or `replace`. If the version moved, block with `draft changed during submit`. Report `submit.transform` and `submit.block` separately, the gestures you cover, and `guardPosition`: `final-boundary` only if you probed that the call runs after every native peer, right before transport. If the host has a later hook that sees the final text (Claude `UserPromptSubmit`), call `session.finalGuard({text, gesture})` from it; that pass runs guards only.
9. **Committed sends.** Call `onSubmitCommitted` (`HostSubmitAccepted`) once per submission, only after native peers ran and the host accepted the prompt, with the final text, a unique `submissionId` and the real gesture. Never for a block, a transport failure or a newline, and never synthesized from a `send` decision. Report `submit.committed: 'accepted-text'` only if you do this; the core sets `level` (`observed`) and infers the rest (`inferred` from a forwarded send followed by an empty draft with no key in between, else `onSubmitUnresolved`). *Fake-only.*
10. **Attribution.** Third-party edits go through `applyAttributedEditIfVersion` (with the `EditAttribution` record), third-party ghosts through `showAttributedGhost`; return `unsupported` if the host can't show attribution, and report `edit.attributed` and `inline.attributed` honestly. Menu rows arrive as `PresentedMenuItem` with the core-set `owner`; route selections by `owner` and `id`, never by label. *Fake-only.*
11. **Presentation.** `showGhost`, `showMenu`, `showHighlight` and `showStatus` are version-bound and return an `ActionResult`; unsupported returns a code, never throws. Keep transient UI out of native undo. Report `ui.dialogSafe: true` only if Murmo status can never cover a host approval dialog; otherwise all Murmo status is hidden. *Fake-only.*
12. **Coexistence** (optional, phase 25). Report `coexistence` only from a measurement in this session. Absent means unknown, and unknown is never treated as safe.
13. **Unsubscribe.** Every subscription returns a working unsubscribe.

## Per-host limits known so far

From [docs/03-host-integrations.md](../../../docs/03-host-integrations.md); the adapter phases re-measure them on the 2.0 contract.

| Host | Limits to report |
|---|---|
| Pi | Inline in the wrapped editor. Another extension can replace the editor; re-wrap it and report coexistence as unknown until measured. |
| OpenCode | A paste and the keys typed after it can arrive in the wrong order in one chunk; keep those deltas unknown. Listener order with other plugins isn't guaranteed. |
| Codex CLI | The `murmo codex` wrapper: `immediate-managed-transport`, `transport-write` receipts, `inline.maxBytes` 800. Draft certainty is `tracked`, not authoritative. Tab queues a prompt and goes through `onBeforeSubmit`. Overlays may not render non-ASCII text. |
| Claude Code | No atomic async edit: `edit.atomic: false`, `exactRestore: false`. Origin can't be labeled, so typed-only reads are fully masked. The undo key was seen 10 of 30 times; Backspace is the undo. `UserPromptSubmit` is the final guard position. |

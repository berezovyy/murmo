# Agent events API 0.4-preview

Companion to prompt API `2.0-pre.0`. Import `@murmo/api/events`. Types are in `src/events.ts`. This preview is opt-in (`[events] enabled = false`) and can change without breaking the prompt API.

One plugin may export existing prompt hooks plus optional `events` / `onAgentEvent`. Event grants are independent of `draft:read`.

## Four rules

1. **A slow guard fails open** on Claude and Codex command hooks. Murmo writes a 5,000 ms native timeout and answers `continue` at 2,000 ms (`EVENTS_GUARD_BUDGET_MS`) with a `guard-timeout` fault. A late deny is never sent. Where Murmo owns the barrier (Pi; OpenCode after live proof) the default is fail-closed; the user can set fail-open. No Murmo setting makes a Claude or Codex command guard fail closed.
2. **Wait for idle, not turn end.** `agent.idle` is emitted only from a native settled signal. Ghosts use `GhostProposal` and apply the ordinary `2.0-pre` ghost effect only after idle, on an empty known draft, with no popup or dialog.
3. **Slow observers lag.** Each plugin has a bounded FIFO (256 events or 1 MiB). Overflow coalesces `message.delta` only, then drops the oldest non-terminal observer events and emits `delivery.gap`. Barriers never queue behind observers.
4. **Separate permissions:** `events:read`, `tools:guard`, `tools:rewrite`, `context:write`, `agent:send`, `agent:control`, `messages:rewrite`.

`tools:rewrite` and `messages:rewrite` exist as types; no adapter advertises them in this preview. `agent:send` is off. Codex hook trust is the user's native review; Murmo never ships `bypass_hook_trust`.

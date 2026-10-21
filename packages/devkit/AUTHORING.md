# Authoring against draft 2.0-pre

The plugin API is a **preview** until Murmo v1. Breaking changes bump `API_DRAFT`
(`2.0-pre.0` today). Read `packages/api/docs/CHANGELOG.md` and
`docs/plan/03-plugin-api.md`.

## Commands

```sh
murmo plugin new hello
murmo plugin test hello
murmo plugin test hello --profile claude --executor all
murmo plugin dev hello --profile codex
```

Until phase 27 mounts `murmo`, run `node packages/devkit/src/cli.ts plugin …`
from the repo. The functions `pluginNewCommand`, `pluginTestCommand` and
`pluginDevCommand` are what the CLI will mount.

`new` writes `murmo.plugin.json` (`api: "^2.0.0"`), a self-contained
`plugin.mjs`, a copy of the public types, `plugin.test.mjs` and a README. It
refuses an existing folder and refuses an entry that escapes the package via
symlink.

`test` (default `--executor all`):

1. Manifest preflight, settings schema, required and optional capabilities —
   before any plugin code runs.
2. One case per declared missing required capability (must refuse at load) and
   per optional one (must degrade).
3. Six adapter invariants and the canonical core conformance suite
   (71 passes + 1 explicit trusted-CPU skip in-process, plus containment).
4. The author's `plugin.test.mjs` in a bounded guest on each selected executor
   (`in-process`, QuickJS-in-Node, `murmo-plugin-host`) and profile, with
   default budgets.
5. A route-parity probe (`onSubmitCommitted`, `ctx.storage`, `ctx.project.read`).
   Missing routes fail naming the route. If the helper binary is not built for
   this platform, `test` says so and skips the helper route (phase 26).

Non-zero exit on any hook fault, disabled plugin or missing service route.

`dev` keeps one fake host and draft across module generations. Stdin commands:
`type`, `paste`, `burst`, `packet`, `key`, `state`, `submit`, `timeline`, `quit`.
JSON-line logs carry timestamps, generation, origin, ordered deltas, committed
version, visible UI and faults. `timeline` returns the last 500 events. A bad
manifest keeps the active generation; a bad module restores the previous code
(storage writes are not rolled back). EOF, `quit`, SIGINT and SIGTERM dispose
everything with 0 subscriptions left.

## Trust boundary

The author's **test** module is trusted Node code. The **plugin** module has no
authority in any executor. Run someone else's plugin and tests only inside a
`--network none` container. Our own tests run the devkit under the offline
wrapper (no network, isolated HOME, removed on exit).

## What a fake pass does not prove

No profile reproduces frames, terminal decoding, native undo history, real IME
or attachments. Historical profiles never claim 2.0-pre guarantees that no real
adapter has shown (`edit.attributed`, `dialogSafe`, `submit.committed`). A
plugin that passes here can still degrade on a stock host (lesson 73, E8).

## Profiles

`--profile fake|claude|codex|opencode|pi`. Seeded from round 13/14 capability
records (`packages/fake-host/records/`), marked historical until adapters 21–24
emit fresh JSON.

| Profile | Quirks |
|---|---|
| `claude` | keyless burst and paste have unknown origin; async edit unsupported; partial key observation; menu Enter goes through the submit boundary |
| `codex` | tracked certainty; Tab queues; native popup Tab passes; managed submit; status 99 characters |
| `opencode` | same-packet paste after following typed text; `dialogSafe: false`; status in a footer slot |
| `pi` | one editor slot (`FakeEditorSlot`); a peer `replace()` displaces us; opaque pastes |

## Public driver

`createFakeDriver(adapter, session)` from `@murmo/fake-host`: `type`, `key`,
`fill`, `burst`, `packet`, `submit`, `state`, `observe`, `settle`. Assertions
use committed snapshots and transport requests, never counters.

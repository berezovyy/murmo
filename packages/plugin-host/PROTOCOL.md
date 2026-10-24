# murmo-plugin-host protocol

JSON lines, request IDs, out-of-order replies across plugins, serial per plugin. Functions never cross the wire.

The supervisor writes a ready line as soon as it starts:

```json
{"ready":true,"pid":123,"protocol":1,"apiVersion":"2.0.0","version":"0.1.0"}
```

`--http --socket PATH` folds the Claude HTTP proxy into this process (no extra manager). Ready then also has `socket`. `POST /rpc` carries the same JSON body as a stdio line; `{"op":"shutdown"}` answers `{"status":"ok"}`, then the helper stops its workers, removes the socket and exits. Otherwise it serves until its parent exits: Claude's `$.process.spawn` gives it no stdin, so stdin plays no part in this mode. The socket file is mode 0600 and there is no TCP listener (a loopback port is open to every local user).

## Handshake

```json
{"op":"hello","id":1,"protocol":1,"apiVersion":"2.0.0"}
```

The client must refuse a binary whose `protocol` or `apiVersion` does not match. `apiVersion` is the plugin API (`2.0.0`), not the helper crate version.

## Ops

| Op | Body | Reply |
|---|---|---|
| `hello` | `protocol`, `apiVersion` | `{status:"ok", protocol, apiVersion}` or `kind:"transport"` |
| `load` | `plugin`, `source`, `format:"esm"`, `settings`, **`memoryMiB` (required)**, `sliceMs`, `assets`, `members?`, `sandbox?`, `networkOrigins?`, `projectRoot?` | `{status:"ok", metadata, members}` |
| `join` | `plugin` (first-party group), `member:{id,source,settings,assets}` | `{status:"ok", metadata}` |
| `call` | `plugin`, `hook`, `input`, `context`, `deadlineMs`, `callToken`, `member?`, `resume?`, `replies?` | `{status, value/requests, kind?, timings, generation, restarts, stateReset}` |
| `cancel` | `plugin`, `callToken` | `{status:"ok", cancelled}` — replaces the worker even if a reply raced |
| `ping` | | `{status:"ok", pong:true}` |
| `stats` | | plugins, hooks, services actually carried |
| `remove` | `plugin` | `{status:"ok"}` |
| `shutdown` | | process exits |
| `fault` | `plugin` | worker exits 77; **test builds only** |
| `names.load` | `path` (names.bin) | `{status:"ok", records, residentBytes}` |
| `names.search` | `raw`, `key?`, `limit?`, `budgetUs?` | `{status, rows, ids, visits}` — 96 candidates, 300 µs; rows include `source` bits (phase 38) |
| `names.unload` | | `{status:"ok"}` |

Store protocol (Claude sessions, same socket): `storage.get/set/delete`, `private.get`, `generation.get`, `words.add`, `log.append`, `project.id`, and draft rescue's `drafts.save/read/delete/markAttempted/lock/unlock/offer/cleanup` (`drafts.lock` is held by the helper process, so a session's draft becomes offerable once its helper has exited with it). Handled by `murmo-store::Store::handle`. Plugin `ctx.storage` does **not** use this path; it request/resumes to the coordinator.

Config (Claude sessions, same socket): `{"op":"config.load","cwd":"/abs/dir"}` → `{status:"ok", session}`, where `session` is the JSON of `@murmo/config/node`'s `SessionConfig` without stamps (`trust`, `effective`, `user?`, `project?`). Handled by `murmo-config::load_session_config` with the helper's own `HOME`, `XDG_CONFIG_HOME` and store roots; `tools/config-parity.mjs` holds it to the Node loader. A relative `cwd` is a `transport` error. Claude's runtime cannot check a project file's trust itself (no lstat, realpath or `O_NOFOLLOW`).

## Assets

Once at `load`/`join`, never per change. Each asset is `{encoding:"base64", data:"..."}`. A JSON array of numbers is refused. Total ≤ 4 MiB.

## Guest

QuickJS (`rquickjs` 0.12.2). No `std`, `os`, `process`, `fetch`, `require`, or module loader. Supplied: monotonic `__hostNow`, `setTimeout`/`setTimer`/`sleep`, wall clock, UTF-8 decoder, settings JSON, `__murmoAssets` as `ArrayBuffer`. **The worker reads no files.** Project reads go through the coordinator broker (`status:"broker"` then `resume` with `replies`).

Workers start with an empty environment and a neutral working directory. Third-party workers (`sandbox: true` on `load`) run under an OS sandbox: macOS `sandbox-exec` (deny network, exec, fork); Linux landlock for files plus seccomp denying `execve`/`connect`. Built-ins share a guest without it. If the sandbox cannot be applied, third-party `load` fails.

## Limits

- Memory: `memoryMiB` required; default admission 8, max 128. No 32 MiB fallback.
- Stack: 256 KiB (the published API figure; a recursion fixture holds >200 frames).
- Source init: 100 ms interrupt, 500 ms supervisor wait.
- Hook slice: 5 ms of **thread CPU** (`CLOCK_THREAD_CPUTIME_ID`) → `kind:"cpu"`.
- Wall deadline: `deadlineMs`; supervisor watchdog = that + 50 ms → `kind:"wall-timeout"`.
- Response ≤ 64 KiB and ≤ 128 effects → `kind:"output-limit"`.

## Faults

Every error reply has `kind` in `{cpu, wall-timeout, memory, plugin, output-limit, cancelled, transport, session-exit}`. Classification uses the engine error type (`rquickjs::Error::Allocation`) and which deadline fired, not substring matching.

A worker crash, OOM or cancel race replaces that worker, bumps `generation`, and sets `stateReset:true`. Closure state is lost.

## First-party group

One worker, several `members` with separate descriptors and settings, shared failure domain. Strangers never `join` it.

## Service resume

A guest `storage.*`, `project.read`/`readFile`/`list`, `network.request`, or `git.query` call yields:

```json
{"status":"broker","requests":[{"id":1,"method":"storage.get","args":["k"]}]}
```

The client answers from the coordinator and sends:

```json
{"op":"call","plugin":"p","resume":true,"replies":[{"id":1,"value":{"status":"ok"}}], ...}
```

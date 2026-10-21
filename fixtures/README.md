# fixtures

Every input → expected-result case Murmo cares about, in one format, run unchanged by one runner (`packages/conformance`) on Node, Bun, QuickJS-wasm and rquickjs, against pure functions, the core, the real helper or a real host. Design: [docs/plan/02](../docs/plan/02-fixtures-and-conformance.md).

**The rule:** every bug found on a real host adds a fixture case here before the fix lands. The case fails first, then the fix makes it pass.

## Commands

```sh
node packages/conformance/src/node/cli.ts check         # schemas, index, counts, plugins, moved bytes, escapes
node packages/conformance/src/node/cli.ts run           # pure subject on all four runtimes, then compare
node packages/conformance/src/node/cli.ts run --runtime rquickjs --out verdicts.jsonl
node packages/conformance/src/node/cli.ts compare a.jsonl b.jsonl
node packages/conformance/src/node/cli.ts self-test     # flip one expectation per suite; it must fail
pnpm test:conformance                                   # the gate (offline; needs Bun, or MURMO_BUN)
```

## Layout and ownership

| Folder | What | Owner |
|---|---|---|
| `schema/` | JSON Schema per kind; `common.json` holds shared shapes | 02 |
| `suites.json` | every fixture file, its owner and declared size | 02 |
| `plugins.json`, `plugins/` | plugin names cases may use; fixture plugins (test code) | 02, 09 |
| `text/` | offsets, graphemes, unsafe text (pure functions) | 04 |
| `provenance/` | operation sequences → typed spans | 04 |
| `core/conformance/` | C1–C14 and V1-* from shared-v2, plus the containment extension | 05–09 |
| `core/edits/` | commit failures, owned undo, pending merge, degraded origin, presentation | 05 |
| `core/keys/` | shared-key refusal, menu Enter on four host profiles, raw-sequence → canonical ID (adapters) | 06 |
| `core/inline/` | boundaries, bursts, shortcut sizes | 07 |
| `security/` | hostile plugins and third-party rules, with 2.0-pre verdicts | 09, 32 |
| `autocorrect/` | round-4 50 prompts, r7 Unicode cases | 13 |
| `config/` | r8 TOML corpus, r12 hostile files, schema v1 branches (`config.parse`); r8 trust attacks (`config.trust`, needs a file system) | 14 |
| `shortcuts/` | r8 expansions, must-not-expand, size boundary, collisions; `replacements/` is the moved r8 project folder | 15 |
| `names/` | splitter 29 cases (moved file read through a table) | 19, 36 |
| `stress/` | huge paste, regex-heavy inputs, IME and normalization stand-ins | 02 |
| `generators/` | seeded generators (code) and their run files | 02 |
| `hosts/` | real-host contract cases (round 14 follow-up fixes) | 20, 29 |

Every file carries `provenance` (source, license, author). All fixture text is our own: nothing from the typos list or other CC BY-SA data.

## Kinds

Types: [`format.ts`](format.ts). The schemas say the same for the validator; change both together.

- **`editor-ops/v1`**: `steps` an editor sees, then `expect`. Steps: `type` (key by key), `burst` (one native transaction of ordered deltas, each with its origin), `paste`, `ime`, `fill` (programmatic, origin `fill` unless stated), `history`, `key` (canonical ID, optional `routing` it must get), `move` (absolute UTF-16 offset), `select`, `state` (partial host state, a named state, or `$variant`), `submit` (gesture), `settle`, `waitMs`, and `check` (expectations that must hold at that point). `defaults` sets `plugins`, `trust`, `pacing`, `host`, `settings`, `project`, `requires` or `grants` for every case in the file.
- **`pure-fn/v1`**: `{id, fn, input, output}`; or a `table` that reads cases from a moved file by field name.
- **`generator/v1`**: generator name, seed, PR and nightly sizes, what runs the generated cases, where shrunk failures go, and reference counts.
- **`moved/v1`**: files moved as-is from an experiment, with the source's SHA-256. Never edit them; Biome skips them.

Offsets are UTF-16 code units everywhere. Large text uses `{"repeat": "ab", "times": 3}` and arrays (`["head ", {"repeat": "x", "times": 1048576}, " tail"]`), never a large file.

## Adding a case

1. Pick the owning folder and file (or make one with `kind`, `offsets`, `provenance`).
2. Write the steps as editor operations with their origins, not key streams, and say where input came from: the oracle never infers typing from text (lesson 52).
3. Expect only what the case is about. Every field becomes an assertion; a case with none fails (anti-vacuity).
4. Write invisible characters as `\u` escapes: ZWJ, combining marks, bidi controls, variation selectors, non-ASCII spaces. A raw one fails `check`.
5. Update the file's `cases` (and `variants`) in `suites.json`; a file missing from the index, or a count that differs, fails `check`.
6. Run `check`, then the subject that owns the case.

**Trust.** `trust` is `builtin`, `third-party` or `both` (the default: run once per level). `expect.thirdParty` replaces fields for the third-party run. The ported canonical cases are `builtin`, as `run.mjs` loaded them; third-party rules live in `security/`.

**Skips.** `requires` lists capability paths (`executor.isolated`, `fn.text.offsets`); an unmet one skips the run with its reason, never passes it. A `skip` entry is a reviewed exception with a reason; only declared skips may differ between runtimes in `compare`.

**Timing.** `control: true` runs a same-time zero-plugin control; `timing.keyMs` and `timing.changeMs` are budgets over that control (lesson 65); `timing.baseline` bounds a case at a factor of another case's time. PR runs report timing; nightly runs gate on it.

**Plugins.** A case names plugins from `plugins.json`: `fixture` ones are test code in `plugins/` (2.0-pre plugin shape); `provided` ones come from the subject (our own plugins and API samples). A plugin with its own ID and settings is `{"id": "attacker", "plugin": "hostile", "settings": {...}}`.

## Generators

`generators/*.ts` are portable and seeded with xorshift32, so a seed replays the same streams on every runtime; `generators/streams.json` pins each one's counts and stream hash. Burst with seed 1306637 reproduces the round 13–14 cohort (189,268 input units, 12,489 corrections, 9,658 undo checks, 68,936 ledgers). Ledger (seed 4040404, 10,000 sequences) drives `provenance.ledger` with random typed, burst, paste, IME, fill, plugin, replace, move, select and undo steps against its own oracle; change `generators/ledger.ts` and its pinned summary must be recomputed. The unicode corpus is also checked in Rust (`packages/js-runtime/tests/text_parity.rs`); `text/` files that hold lone surrogates are JavaScript-only, since a Rust `String` can't hold them. A failing generated stream is shrunk against the subject and saved as a fixed case in the file named by `failures`, with its `suites.json` entry updated (`saveFailures` in `packages/conformance/src/node/regressions.ts`). A shrunk pure case has no oracle output, so it is saved with `output: null` and fails until someone reviews it.

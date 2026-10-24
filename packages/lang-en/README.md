# @murmo/lang-en

The English language pack: Murmo's own typo data, built offline from pinned inputs. Design and evidence: [docs/plan/12](../../docs/plan/12-language-data.md). The pack format is in [`@murmo/lang`](../lang/README.md).

```sh
node packages/lang-en/src/cli.ts build      # inputs/ → dist/pack/ (about 10 s)
node packages/lang-en/src/cli.ts verify     # independent verifier over the pack
node packages/lang-en/src/cli.ts gate       # evaluation gate; exits 1 on a regression
```

`pnpm test` builds a fresh pack and checks it against `expected.json` (SHA-256 `7a9cfed9…c59419`), runs the verifier and the gate. The pack is not committed: it is rebuilt from `inputs/` wherever it is needed.

## What goes in

| Input | What it does | License |
|---|---|---|
| `scowl-2020.12.07.tar.gz` | levels 10–20 are the correction targets; all lists are the real-word guard | SCOWL notices, shipped as `licenses/SCOWL-Copyright` |
| `web2.txt.gz` | frozen system dictionary; removes keys that are words | public domain (`web2-README`) |
| `project-terms.txt.gz` | identifiers from four projects' code; removes keys | subtraction only, never shipped |
| `programming-terms.txt`, `base-vetoes.json` | hand-protected terms; vetoed generated keys | ours |
| `authored.txt`, `authored-review.json` | the hand-written common typos and their review | ours |
| `case-policy.json` | keys that correct only in lowercase (`teh`, `adn`, `thier`) | ours |
| `inline-overrides.txt` | `wich→which`, `i→I` | ours |

`inputs/sources.json` pins every file by SHA-256; the build refuses a file that differs. **Nothing from a public typo list** (typos, codespell, misspell, Wikipedia: partly CC BY-SA) may be an input or be committed; they are oracles only (`gate --oracle name=path` with a local copy).

## Add a typo

1. Add `typo correction category` to the end of `authored.txt` (categories: `transpose`, `misspelling`, `programming`, `phone`). Write it yourself; do not copy from a list.
2. If the typo is a valid word (any SCOWL list up to level 80) or a protected term, or its correction is not made of known words, the build drops the line and lists the reason in its report (`authored.rejected`). A name or abbreviation that should still be corrected when typed in lowercase (`teh`) goes in `case-policy.json`, with a note in `exceptionNotes` of `authored-review.json`.
3. If the generated base maps the key to another word, the build stops: veto the base key or reject your line.
4. `node packages/lang-en/src/cli.ts pin`, then build, verify and gate. Update `expected.json` with the new hashes and paste the gate table in the PR.

## Veto a generated typo

Add `"key": "reason"` to `base-vetoes.json`, re-pin, rebuild, and update `expected.json`. An authored typo is rejected by adding `"key": "reason"` to `rejected` in `authored-review.json` instead.

## Rerun the gate

`node packages/lang-en/src/cli.ts gate` prints the results as a Markdown table. Limits are in `gate.json`: 0 wrong fixes in 400k clean words, ≤ 29 wrong and ≥ 6,552 applied on the seed-8004 held-out slips, ≤ 3 wrong on the seed-6002 stream, and the 11 required examples. Changing a limit needs a reason in the PR and in `docs/knowledge.md`.

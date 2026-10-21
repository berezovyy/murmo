# @murmo/lang

Language packs at runtime: the packed table format and its reader, the pack manifest and case policy, full validation for install, and the cheap session-start open. Portable (Node, Bun, Claude's realm, QuickJS); file reads, stat and native hashing come from the caller, and `@murmo/lang/node` provides them for Node and Bun. Design: [docs/plan/12](../../docs/plan/12-language-data.md). The English pack is built by [`@murmo/lang-en`](../lang-en/README.md).

## Pack layout

A pack is a directory; every later language follows it.

| File | Format | Read at session start |
|---|---|---|
| `manifest.json` | `murmo-language-pack/v1` | yes |
| `typos.bin` | `packed-sorted-ascii-v1`, ≤ 4 MiB | yes, mapped without a copy |
| `case-policy.json` | `murmo-case-policy/v1` | yes |
| `provenance.csv` | `murmo-provenance-csv/v1` | no (license evidence, verifier) |
| `NOTICE`, `licenses/*` | text | no |

**Manifest.** `kind`, `language` (BCP 47), `policy` (e.g. `strict-common-v1`), then `table` (`file`, `sha256`, `bytes`, `format`, `entries`), `casePolicy` (`file`, `sha256`, `bytes`, `format`), `provenance` (… `rows`), `notice`, `licenses[]` (… `covers`), `sources[]` (every pinned build input: `name`, `version`, `sha256`, `license`, `role`, optional `url`) and `build` (`tool`, `version`). Unknown fields, kinds or formats are refused: correction turns off with a reason instead of guessing.

**Table** (`packed-sorted-ascii-v1`, little-endian): a 32-byte header of eight u32 (magic `1297437261`, entry count `n`, data offset `32 + 8(n+1)`, data length, four zero words), then `n+1` key offsets and `n+1` value offsets into the data, then every key and every value as printable ASCII, keys sorted by bytes. Lookup is a binary search on the bytes. The four reserved words must be zero (other packed indexes use them for nodes, scores and blocks); a new layout gets a new magic.

**Case policy.** `{"format": "murmo-case-policy/v1", "lowercaseOnly": [...], "reason": "..."}`: sorted lowercase keys, each in the table, that are corrected only when typed exactly in lowercase. The manifest binds it to the table by hash, so a table can't be used without its policy. Applying it is the word policy's job ([13](../../docs/plan/13-autocorrect-plugin.md)).

## Validate once, open cheaply

- `validatePack` (build, `murmo setup`, `murmo doctor`): every file's size and SHA-256, every table entry (offsets, bytes, order), the case policy against the table. `installLanguagePack(packDir, recordFile)` runs it and writes the install record (`murmo-language-pack-validation/v1`: validator version, hashes, sizes, mtimes in whole ms); on failure it removes any older record.
- `openPack` / `openLanguagePack` (session start): the manifest, the record (same validator, same hashes as the manifest, same sizes and mtimes), the header ranges, the case policy. No per-entry work. With a native SHA-256 (Node and Bun by default; the Codex wrapper through its trusted loader) the table and case policy are hashed too and `integrity` is `sha256`; without one (Claude's realm) it is `install-record`, and doctor says so. Any failure returns `{ok: false, problem, reason}`.

Measured on the English pack (88,525 entries) by `pnpm test:portable`: open ≤ 6 ms and lookup p99 ≤ 1 ms in Node, Bun, QuickJS-wasm and rquickjs.

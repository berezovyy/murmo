# Round 8 text-replacement fixture

- `.murmo.toml` + `.murmo/*.md`: the project file every host agent uses. Copy it into your own sandbox; do not edit it here.
- `expected.json`: the exact text each shortcut must insert (parsed with Python `tomllib`). A file reference drops exactly one trailing newline.
- Expansion rules: see docs/02-architecture.md "Text replacements and `.murmo.toml`".

# Plugin manifest v1

> **Preview, draft `2.0-pre.0`.** The API can break before Murmo v1; [CHANGELOG.md](CHANGELOG.md) lists every change.

Every plugin package has a `murmo.plugin.json` (`MANIFEST_FILE`) of at most `LIMITS.manifestBytes` (64 KiB, counted in UTF-8). Every loader (devkit, `murmo plugin`, the core, the helper) runs the same preflight before any plugin code: `parseManifest`, `validateManifest`, `negotiate`, `resolveSettings` from `@murmo/api`. A refusal is a `ManifestError` with a `code` and the manifest `path` it is about. The preflight gives the same verdict on Node, Bun and both QuickJS engines.

```json
{
  "name": "example",
  "version": "1.0.0",
  "api": "^2.0.0",
  "entry": "plugin.mjs",
  "permissions": [{ "name": "draft:read", "reason": "Read the draft length." }],
  "capabilities": { "required": { "readDraft": true }, "optional": { "api.typed-read-default": true } },
  "settingsSchema": {
    "type": "object",
    "properties": { "enabled": { "type": "boolean", "default": true } },
    "additionalProperties": false
  },
  "resources": { "memoryMiB": 8 }
}
```

## Fields

The first seven fields are required; `resources` is optional. Any other field is refused (`unknown-field`), and a `builtin` field gets its own refusal (`builtin-field`): built-in trust comes from the host that installs a plugin, never from its files. Signatures, archive hashes and approvals belong to the installer, not the manifest.

- **`name`:** a lowercase npm-style name, optionally scoped (`@acme/lint`), at most 64 characters after the scope.
- **`version`:** the plugin's own version, a stable `MAJOR.MINOR.PATCH` with no leading zeros. **Prereleases (`1.0.0-rc.1`) and build metadata are refused**, so a prerelease can never satisfy a stable range. It must equal `Plugin.version`.
- **`api`:** the range of core API versions the plugin works with (grammar below). This core implements `API_VERSION` 2.0.0.
- **`entry`:** a relative `.mjs` path inside the package: no leading `/`, no drive letter, no backslash, no `.` or `..` segment, no control characters.
- **`permissions`:** `{name, reason}` pairs from the seven API permissions ([api.md § Permissions](api.md#permissions)). The reason is shown to the user and must not be blank; a permission may appear once. `Plugin.permissions` must be a subset. A declaration is never a grant.
- **`capabilities`:** `required` and `optional` maps from a capability path to a requirement; a path may not be in both. See below.
- **`settingsSchema`:** the settings subset below.
- **`resources.memoryMiB`:** a requested guest memory ceiling, an integer from 1 to `LIMITS.maxMemoryMiB` (128). Above `LIMITS.defaultMemoryMiB` (8 MiB) the host must review and admit it; the request alone grants nothing.

## API ranges

| Form | Example | Means |
|---|---|---|
| exact | `2.0.0` or `=2.0.0` | that version |
| caret | `^2.0.0` | `>=2.0.0 <3.0.0`; `^0.2.3` is `>=0.2.3 <0.3.0`; `^0.0.3` is exactly `0.0.3` |
| tilde | `~2.0.0` | `>=2.0.0 <2.1.0` |
| comparators | `>=2.0.0 <2.4.0` | all must hold (`>`, `>=`, `<`, `<=`) |
| alternatives | `2.0.0 \|\| 2.1.0` | any alternative |

Everything else is an error (`invalid-range`), never a match: wildcards (`*`, `2.x`), partial versions (`^2`, `2.0`), hyphen ranges (`2.0.0 - 3.0.0`), prereleases, leading zeros, an empty alternative. A manifest written for `^1.x` is refused with a message: API 2.0 is breaking, so rewrite the plugin for `^2.0.0`.

## Capabilities

A path names a leaf of `Capabilities`, such as `edit.atomic`, `submit.gestures` or `runtime.services` (`CAPABILITY_PATHS`), or a core feature `api.<feature>` (`API_FEATURES`: `typed-read-default`, `submit-observe`, `attributed-edits`, `adaptive-budgets`, all since 2.0.0). A requirement is a boolean or string, which must be equal, or a string array, which must be a subset (in any order).

- A required path the host doesn't meet refuses the plugin (`capability-unavailable`); a required path this API doesn't define refuses it as `capability-unknown`, so a typo is told apart from a missing host feature.
- An optional path is reported in `ctx.negotiation.optional[path]` (true or false) and listed in `missingOptional` when unmet or unknown. No capability is invented.
- Absent optional capability groups, such as `coexistence`, are unmet: unknown is never treated as safe.
- A guard that needs final coverage requires `"submit.guardPosition": "final-boundary"`; the host also marks such a spec `requiredGuard` so a failed load still blocks sends.

## Settings schema

A bounded JSON Schema subset. Any other keyword is refused (`invalid-settings-schema`), so nothing pretends to validate.

- Top level: `type: "object"`, `properties`, optional `required` (declared names only) and `additionalProperties` (boolean).
- A property: `type` (`string`, `boolean`, `number`, `integer`), optional `description`, `enum` (nonempty), `default`, `minimum` and `maximum` (numbers and integers only, `minimum` ≤ `maximum`), `maxLength` (strings only, UTF-16 units). The `default` must pass the property's own rules. Names `__proto__`, `prototype` and `constructor` are reserved.
- `resolveSettings` fills defaults for absent keys, checks every user value, and refuses a missing required setting. Unknown settings are refused unless `additionalProperties` is `true`; then they pass through if they are JSON data. Settings are copied: a plugin can't change them while it runs.

## Versions and deprecation

During the preview, `API_VERSION` stays 2.0.0 and each breaking change bumps `API_DRAFT`; see [CHANGELOG.md](CHANGELOG.md). From v1 on:

- A minor release adds optional fields, hooks or capabilities. A patch fixes behavior to the existing contract. A removal or a changed required field needs a new major.
- A deprecation names its replacement and lands in the CHANGELOG. Removal waits at least two minor releases **and** 90 days from the notice, and still only happens in a major.
- A plugin's own version is independent of the API: use its major for breaking settings, storage or behavior changes, and migrate your own storage values.

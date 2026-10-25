# Murmo

Murmo is a plugin system for the prompt box of coding agents. You write a plugin once and it runs in Claude Code, OpenCode and Pi (Codex CLI runs the built-in ones), without patching or forking any of them. Plugins can read what you type and tell it apart from a paste, change the draft, show menus and status, and check a prompt before it is sent. Plugin code never runs on the keystroke path, and an installed plugin runs locked down with only the permissions you approved.

Everything runs locally. Murmo sends nothing anywhere.

## What you get

- **Shortcuts.** Type `;rvw` and a space, and it expands into a full prompt. Your own shortcuts live in `~/.config/murmo/murmo.toml`, which setup creates with a few to try. A project's `.murmo.toml` shares shortcuts with the team; run `murmo trust` to review it before it turns on. Templates can hold `<field>` placeholders with defaults. Edits to either file apply without restarting the agent.

  **Why not macOS Text Replacements?** Murmo's shortcuts work like the ones in System Settings → Keyboard → Text Replacements (`omw` becomes `On my way!`), but those only apply in native Cocoa text fields. Terminal apps don't support them, so they never reach the prompt box of a coding agent. They are also personal only, with no project file to share, and in practice single-line. Linux has nothing like them built in. Murmo runs inside each agent's own prompt box, so it works in any terminal, on macOS and Linux alike.

- **The `;` menu.** Type `;` and part of a name, alias or description, then pick a shortcut with the arrows and Enter.
- **Draft rescue.** If the agent crashes or you quit with an unsent prompt, the next session offers it back. Tab restores it.
- **Autocorrect (off until you turn it on).** It fixes common typos when you finish a word or press Enter (`teh` becomes `the`). It leaves code, shell commands, paths, URLs, flags, project names and pasted text alone. Backspace right after a fix undoes it. To turn it on, add this to `murmo.toml`:

  ```toml
  [autocorrect]
  enabled = true
  ```

- **Your own plugins.** `murmo plugin new` starts one. `murmo plugin add ./my-plugin` installs it after showing you the permissions it asks for. The authoring guide ships in the package as `docs/AUTHORING.md`.

## Supported agents

| Agent | Tested versions | Shortcuts | `;` menu | Template fields | Draft rescue | Installed plugins |
|---|---|---|---|---|---|---|
| Pi | 1.2.0, 1.3.0 | yes | yes | Tab and Shift+Tab | yes | yes |
| OpenCode | 2.1.0, 2.1.1 | yes | yes | Tab | yes | yes |
| Claude Code | 2.1.302 to 2.1.304 | yes | yes | edit by hand | yes | yes |
| Codex CLI | 0.162.1, 0.163.0 | yes | no | edit by hand | no | not yet |

macOS and Linux on arm64. Node 24.18 or newer.

Some limits come from the agents themselves. Claude Code gives plugins no Tab or Escape, so template fields there are edited by hand. Escape then Enter in its `;` menu also needs one extra Enter. OpenCode 2.0.x is not supported.

## Install from source

There is no published package yet. To build and install from this repository, you need Node 24, pnpm, Rust (the toolchain in `rust-toolchain.toml`) and OpenSSL:

```sh
tools/offline/fetch.sh                                   # pnpm install + cargo fetch
openssl genpkey -algorithm ed25519 -out murmo-key.pem    # your own signing key
openssl pkey -in murmo-key.pem -pubout -out murmo-key.pub.pem
node tools/pack.mjs --key murmo-key.pem                  # builds dist/release/package
node dist/release/package/cli.mjs setup --key murmo-key.pub.pem
```

Setup finds the agents you have and installs Murmo into each one. Then start your agent and type `;rvw` followed by a space. `murmo doctor` shows what is installed and loaded.

## Development

```sh
pnpm lint && pnpm check   # Biome and TypeScript
pnpm test                 # unit tests, with the network blocked
pnpm test:conformance     # the shared fixtures on every runtime
pnpm rust test --offline  # the Rust helper
```

`AGENTS.md` has the full command list and the rules for changes.

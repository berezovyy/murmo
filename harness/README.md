# harness

The real-host test harness (docs/plan/20): stock Claude Code, Codex CLI, OpenCode and Pi at pinned versions, on macOS and Linux, against a fake model server, with the network blocked at the OS level, a throwaway home per session, and a stop rule that halts everything when a real provider shows up. Murmo's adapters (phases 21–24) plug in through `murmo_harness/integrations.py`; every later phase that touches a real host goes through this harness.

Python 3.11+ standard library plus pyte (test tooling only, never shipped).

**Read the safety rules below before running anything. Agent briefs that drive the harness repeat them, with the disk rules in `AGENTS.md`.**

## Safety rules (the user's, verbatim)

These were set by the user for every real-host run. Loosening any of them needs the user's explicit approval.

SAFETY RULES (non-negotiable; loosening any needs the user's explicit approval, which you don't have):
1. Never submit prompts to real models. Only a local fake model server on 127.0.0.1 with a fake key; never log request headers.
2. Block outbound network for every host run: `docker run --network none`, or macOS `sandbox-exec` allowing only localhost.
3. STOP RULE: if a host shows a real provider URL or hostname (in a session screen, status line, error, config dump or network attempt), stop at once, kill everything, and report it. Exception approved by the user: a provider hostname that appears only in a host's help or documentation text inside a `--network none` container does not trigger the stop.
4. Codex runs always pass `-c model_provider=<fake>` and `openai_base_url` pointing at the fake server.
5. Claude runs: verify the profile before every launch (fake URL, fake key, onboarding/trust seeded), and re-check after any `claude plugin install`.
6. OpenCode runs: set `OPENCODE_CONFIG_PROJECT_DISABLE=true`, `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=true` and an explicit `OPENCODE_CONFIG`.
7. Third-party code (cloned plugins, ecosystem code) runs only inside `--network none` containers.
8. Use isolated temporary HOME and config dirs for every run, and delete them afterwards.
9. No global installs, no shell rc edits, no publishing, no git push. Host binaries install into a harness cache (use /Users/berezovyy/Projects/murmo/experiments/.cache/hosts/<host>/<version>, shared by all worktrees, git-ignored) via npm/pnpm into that folder; Python + pyte into a venv inside that cache. Downloading host packages from the npm registry (and Docker base images) is allowed; nothing else on the network.
10. Kill every process you start (hosts, helpers, tmux servers with a harness-specific socket, containers you started). Never touch Docker containers or images that aren't yours (name/label yours, e.g. `murmo-harness`).
11. Don't read private user data: the "real HOME untouched" check may only compare file metadata (names hashed, sizes, mtimes) of ~/.claude, ~/.codex, ~/.pi, ~/.config/opencode, ~/.agents, ~/.npm — never read file contents, never log names in clear.
12. Disk hygiene per AGENTS.md: keep only the last 3 run outputs per measurement; shared CARGO_TARGET_DIR via tools/cargo.mjs.

## Safety rules (docs/plan/20, verbatim)

These rules apply to the harness and to any person or agent running a host for Murmo. Briefs for agents that drive the harness repeat them, together with the disk rules in `AGENTS.md`.

1. **Fake model server only.** One fake server listens on `127.0.0.1` on an ephemeral port. Every host is configured for it with a fake key (`murmo-harness-fake-key`): `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` for Claude; `models.json` with a `murmo-local` provider for Pi; an `openai-compatible` provider in an explicit `OPENCODE_CONFIG` for OpenCode; for Codex, `-c model_provider="murmo_local"`, `-c openai_base_url=…` and the full `model_providers.murmo_local.*` set **on the command line**, never only in `config.toml`. The server rejects any other key with 403 and never logs request headers.
2. **Outbound network is blocked at the OS level** for every host process, including one-off `--version` and `--help` probes and host commands run during setup:
   - Linux: `docker run --network none`. Images are built in a separate step that has network and never starts a host session.
   - macOS: `sandbox-exec -f harness/sandbox/network.sb`: `(deny network*)`, then allow only `localhost:*` outbound, inbound and bind, and local and remote Unix sockets. The profile also denies reads of the real `~/.claude` and `~/.agents`. **Decided:** it also denies the mDNSResponder socket (no name resolves, loopback by address still works) and any access to the real `~/.claude.json`, `~/.codex`, `~/.pi`, `~/.npm`, `~/.config/opencode` and OpenCode's data folders, because a stat of those is already a read of the user's state.
   - A fake-provider config alone is never enough.
3. **Self-test before each run:** inside the same sandbox, a connection to the fake server succeeds and a connection to `1.1.1.1:443` fails. If either result is wrong, no host is started.
4. **Isolated temp HOME and config dirs.** Each run creates a new temp folder holding `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`, `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG` and `npm_config_cache`, plus a synthetic project folder with its own `.git`. Set `OPENCODE_CONFIG_PROJECT_DISABLE=true`, `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=true`, `OPENCODE_DISABLE_MODELS_FETCH=1`, `OPENCODE_DISABLE_AUTOUPDATE=1`, `DISABLE_AUTOUPDATER=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1`, `PI_TELEMETRY=0`; Codex config has update checks, analytics and feedback off and history persistence `none`. Remove inherited `ANTHROPIC_*`, `OPENAI_*`, `CLAUDE_CODE_OAUTH*`, `CLAUDE_CODE_USE_*`, Claude session variables, `AWS_*`, `GITHUB_TOKEN`, `GH_TOKEN` and `MURMO_*`.
5. **Check the profile before every launch**, not only at setup: merge (never "seed if absent") Claude onboarding, folder trust and fake-key approval into `.claude.json` after any plugin install; assert the fake base URL and key in env and settings; assert every config path lies inside the run's temp folder. A failed check means no launch.
6. **Never submit to a real model.** No real credentials exist in any profile or environment. Drivers press Enter (or Codex Tab) only in cases whose purpose is a submit, only after rules 1–5 passed, and only with synthetic fixture text. Drivers never send control text through the prompt; they check the host mode (shell, Vim, menu) before typing and use files or environment for control.
7. **Stop if a real provider URL appears in a session.** A watchdog scans every screen frame and status line (ANSI and whitespace removed), host log, error output, written config and config dump, the fake server's log, and the sandbox's denied-connection records for real provider hostnames: `api.anthropic.com`, `api.openai.com`, `*.openai.azure.com`, `bedrock-runtime.*.amazonaws.com`, `generativelanguage.googleapis.com`, `openrouter.ai`, and bare forms of these. On a hit it kills every host process in the run (all hosts, not just the one), marks the run `STOPPED-PROVIDER`, keeps the evidence, and the run is not resumed until a person has reviewed it. **Exception:** a hostname printed inside `--help` or documentation text in a no-network container doesn't count; anything in a session, error, config or network attempt does.
8. **Third-party code runs only in `docker --network none` containers** with no mount of the real HOME (peer plugins, ported third-party plugins, anything fetched from a public repository). It never runs on the macOS host, even under `sandbox-exec`.
9. **Synthetic data only.** No private prompt history, transcripts or credentials are read or copied. Real repositories are used only as read-only clones in the harness cache.
10. **No global changes.** Hosts are installed into the harness cache, never globally. Nothing writes to the real `~/.claude`, `~/.codex`, `~/.pi`, `~/.config/opencode` or `~/.npm`. tmux runs as a private server (`tmux -L murmo-<run> -f harness/tmux.conf`), never with the user's tmux config.
11. **Clean up.** Each run kills every process it started (process group, tmux server, helpers, fake server) and removes its owned containers on exit, even after a failure; deletes its temp HOME, profiles, sockets and temp npm cache; then checks that no host, helper or server process remains and no temp folder is left, and records the check. It never touches another run's containers.
12. **Disk hygiene** (`AGENTS.md`): every build of the same Rust repo uses one shared `CARGO_TARGET_DIR` (in the experiments, `experiments/.cache/cargo-target/<repo>`), never a per-run `target/`, and `target/` is never copied; `node_modules` and host installs are reused while lockfiles are unchanged; outputs go to `harness/out/<suite>/<host>/<attempt>/`, keeping only the last 3 attempts per measurement, and older ones are deleted once their numbers are recorded. Agent briefs repeat these rules.

## Where the code enforces each rule

Nothing here relies on convention: every check below refuses the launch or stops the run.

| Rule | Enforced by |
|---|---|
| Fake server only, fake key, no headers | `fake_model.py`: one server on `127.0.0.1:<ephemeral>`; any key but `murmo-harness-fake-key` gets 403; request bodies are logged as JSONL, headers never (the key is compared and dropped). Unknown routes get 404 and are flagged. |
| Network blocked | macOS: `sandbox.py` renders `sandbox/network.sb` per run (deny all network, allow only `localhost`, local Unix sockets, deny the mDNSResponder socket so no name resolves, deny any access to the real `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.pi`, `~/.agents`, `~/.npm`, `~/.config/opencode`, OpenCode's data folders) and re-reads it before every launch. Linux: `container.py` runs the whole harness in `docker run --network none`, the image built in a separate step (`pnpm harness image`). |
| Self-test | `Run.open()`: inside the same sandbox a probe must reach the fake server, fail `1.1.1.1:443` at once with a blocked errno, and fail to resolve a provider hostname; otherwise `SandboxBroken` and no host starts. |
| Stop rule | `watchdog.py` scans every PTY read and settled screen, the window title (status line), every followed host log, every one-off command's stdout and stderr, every written config file and the environment, every fake-server record, every trapped network attempt and the sandbox's denial records, with ANSI and whitespace removed, so wrapped and split hostnames count. A hit kills every process of the run (all hosts), writes `STOPPED-PROVIDER.json` into the evidence and a global marker (`<cache>/STOPPED-PROVIDER.json`) that blocks every later launch in every worktree. The help/doc exception applies only to text scanned as `help` inside a no-network container. |
| Network attempts named | `trap.py`: every profile points `HTTP(S)_PROXY`/`ALL_PROXY` at a loopback trap (loopback excluded via `NO_PROXY`, Node told to honour it with `NODE_USE_ENV_PROXY`). The trap records method and target only, answers 403, and hands the target to the watchdog. macOS redacts denied addresses and a `--network none` namespace records nothing, so without the trap an attempt would carry no hostname. |
| Codex flags | `hosts/codex.py`: `-c model_provider="murmo_local"`, `-c openai_base_url=…` and the whole `model_providers.murmo_local.*` table on every Codex command line, probes included; the pre-launch check refuses a command line without them. |
| Claude profile | `hosts/claude.py`: `--settings` with the fake URL and key on every Claude command; before every launch and every host command (so also after `claude plugin install`) onboarding, folder trust and the fake key's approval are merged (never seed-if-absent) into both `.claude.json` files, then verified; a settings file pointed anywhere else is refused, never repaired. First-run screens the seeding should prevent fail the session instead of being clicked through. |
| OpenCode env | `safety.REQUIRED_FLAGS` and `hosts/opencode.py`: the three variables plus `OPENCODE_DISABLE_MODELS_FETCH`, `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_DISABLE_DEFAULT_PLUGINS`; checked before every launch. |
| Third-party code | `Integration.third_party`: `Run.open_session` refuses such an integration outside a no-network container. |
| Isolated homes | `profile.py`: a new folder per session (HOME, every XDG folder, each host's config folder, npm cache, TMPDIR, a synthetic project with its own `.git`); the environment is built from an allowlist; the pre-launch check refuses any config path outside the folder and any inherited credential variable; the folder is deleted when the session closes. |
| No global changes | `install.py`: `npm install --prefix <cache>/<host>/<version>/<platform> --ignore-scripts` with an empty user and global npmrc and the cache's own npm cache; pyte into `<cache>/_python/venv`. tmux runs as a private server (`tmux -L <run id>-<n> -f harness/tmux.conf`). |
| Clean up | `procs.py` tracks every process of the run (registered roots, their descendants, the run's terminals and markers); `Run.close()` kills them all, also after a failure, removes the temp folders, and records `cleanup.json` (processes, temp folders, tmux sockets left). `container.py` names and labels each container with its run id and removes only that one. `pnpm harness clean-check` looks for anything of any run. |
| Private data | `inventory.py`: the real-HOME check uses `lstat` only; names are hashed with a salt that never leaves memory; only the fixed folder names appear in reports. |
| Disk | `evidence.py`: `harness/out/<suite>/<host>-<version>-<platform>/<attempt>/`, newest 3 kept per measurement. Host installs are shared by every worktree. |

## Commands

```sh
pnpm harness install python                       # pyte + wcwidth into the cache's venv (or --from-site DIR)
pnpm harness install pi opencode claude codex     # newest pinned versions (--version all, --latest, --platform darwin-arm64,linux-arm64)
pnpm harness image [--target tmux]                # the Linux image (networked; starts no host)
pnpm harness selftest [--linux]                   # the network self-test alone
pnpm harness smoke [--linux] [--driver tmux]      # PR smoke: one typed line, one submit, per host
pnpm harness run --suite fixtures/hosts/stock-canary.json [--host H] [--version all] [--case ID] [--linux]
pnpm harness matrix --version all [--linux] [--real-home-check]
pnpm harness drift [--linux]                      # newest release vs newest pinned: probe diff
pnpm harness load --linux --cpus 0.5 [--cpuset 0] [--trials 20] [--sessions N] [--neighbour]
pnpm harness soak [--linux] [--minutes 2] [--words 200]
pnpm harness validate [--smoke] [--plan] [--write-report] [--section functional] [--linux]
                                                   # phase 29 packed-product matrix; missing hosts skip by name
pnpm harness demo --host pi                        # tmux run → asciinema v2 cast
pnpm harness clean-check
pnpm test:harness                                  # the harness's own tests (pnpm harness test --linux in the container)
```

`--linux` re-runs the same command inside a fresh `--network none` container; `--cpus` and `--cpuset` exist only there (macOS has no CPU quota). The harness runs unsandboxed itself, because macOS cannot nest `sandbox-exec`; every host process it starts is sandboxed. That is also why `pnpm test:harness` is not part of `pnpm test`.

`pnpm harness validate` reruns round 14's load, security, coexistence, soak and distribution checks against the packed tarball (`MURMO_PACKED` or `dist/release/package`) after `murmo setup` in a throwaway profile. A missing stock host or tarball **skips with a named reason** and never passes. `--plan` expands the matrix without launching. `--write-report` writes `docs/experiments/v1-platform-validation.md`.

Host versions live in `matrix.toml`. Installs and the stop marker live in the shared cache: `<main checkout>/experiments/.cache/hosts/` (or `MURMO_HARNESS_CACHE`).

## Layout

| Path | What |
|---|---|
| `harness.py` | entry point (`pnpm harness`) |
| `murmo_harness/session.py` | `Run` (fake server, trap, sandbox, watchdog, processes, cleanup) and `Session` |
| `murmo_harness/sandbox.py`, `sandbox/network.sb` | macOS sandbox and Linux container sandbox; self-test |
| `murmo_harness/container.py`, `docker/Dockerfile` | Linux runs: image build and the `--network none` wrapper |
| `murmo_harness/fake_model.py` | `/v1/messages`, `/v1/responses`, `/v1/chat/completions`, `/v1/models`; modes `ok`, `busy`, `approval`, `slow-first-byte` by a marker in the user text |
| `murmo_harness/watchdog.py`, `trap.py` | the stop rule; the loopback proxy that names network attempts |
| `murmo_harness/profile.py`, `safety.py` | isolated profiles and the pre-launch check |
| `murmo_harness/drivers/` | direct-PTY driver (pyte, answers terminal queries, key-to-frame timing) and tmux driver (`send-keys -l`, `paste-buffer -p`, `capture-pane`) |
| `murmo_harness/hosts/` | one profile per host: install entry, config, launch argv, readiness, draft reader, modes, format canary, known side requests and network attempts |
| `murmo_harness/runner.py` | shared fixture cases → driver steps → conformance verdicts (`subject: host:<name>`) plus per-case evidence |
| `murmo_harness/probe.py` | version probe, format canary, drift diff |
| `murmo_harness/load.py`, `soak.py`, `demo.py`, `inventory.py` | load knobs with a paired control, soak, demo recorder, HOME inventories |
| `murmo_harness/validation/` | phase 29 packed-product matrix, named skips, oracles, report writer |
| `murmo_harness/integrations.py` | the seam for Murmo adapters |
| `tests/` | the harness's own tests, with a stub TUI host for the safety checks |

## Drivers

- Escape is always its own write, followed by a gap; a combined Escape + Ctrl+U write was read ambiguously (r14 H1).
- Draft newlines are Ctrl+J, never a modified Enter (lesson 61). `tmux.conf` has `extended-keys off` and no bindings; `tmux-extended.conf` turns extended keys on to reproduce lesson 61.
- Before typing, the host profile reads the mode off the screen (Claude `!` bash and `#` memory modes, Vim normal mode, any `!` draft) and leaves it, or refuses to type: in shell mode typed text would run (E5).
- Codex pastes go in 800-byte writes (lesson 54); its title run-state is the busy signal, `Starting` means MCP startup.
- The PTY reader answers cursor-position, device-attribute, colour, XTVERSION and kitty-keyboard queries, and strips APC/PM/SOS strings and `CSI <`/`CSI =` sequences that pyte would otherwise draw as text (Claude's kitty-graphics query showed up as `4;AAAA` in the draft, its kitty-keyboard pop `CSI < u` as a stray `u`).
- Process ownership: a run owns its registered roots, their descendants, processes carrying its markers, and processes on its terminals that started after the terminal was registered and before its session was killed. Without the time bound one run once claimed another run's host that the OS had given the same, since-released tty.

## Adding Murmo (phases 21–24)

An adapter phase adds `integrations/<name>.py` defining `INTEGRATION`, an `Integration` subclass (`prepare` installs Murmo into the profile through `Run.host_command`, so the pre-launch check runs again; `argv` wraps the launch, e.g. `murmo codex`, which must keep the rule 4 flags; `logs`, `state`, `read_ui`, `capabilities`, `features`), and per-host expectation files `expectations/<name>/<host>.json` (`kind: host-expectations/v1`; per suite and case, `skip` with a reason or `expect` fields that replace the fixture's). The harness itself does not change. Cases a stock host cannot run (plugins, Murmo UI, offsets, timing against a control) skip with the reason and the phase that adds them; they never pass.

## After a stop

A `STOPPED-PROVIDER` stop keeps all evidence and writes `<cache>/STOPPED-PROVIDER.json`. No host starts anywhere until a person has read the run's evidence (`STOPPED-PROVIDER.json`, screens, `fake-requests.jsonl`, `network-attempts.jsonl`, `sandbox-denied.json`), reported it, and deleted the marker by hand.

## Measured behaviour worth knowing

- Claude 2.1.30x fetches `downloads.claude.ai` and git-clones the official plugin marketplace from GitHub at every start unless `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1`; Codex 0.162–0.163 sync the curated plugin marketplace from GitHub unless `features.plugins`, `remote_plugin` and `plugin_sharing` are off, and always fetch an announcement tip from `raw.githubusercontent.com` at TUI start (no switch found; trapped and listed as a known attempt). None of these is a provider, and all are blocked.
- macOS throttles sandbox violation reports: the denial log is read only as a cross-check, and counted only when the self-test probe's own two denials appear in it.
- OpenCode 2.1.1's TUI (`--standalone`) runs in the `--network none` container (lesson 79 saw its server fail there).

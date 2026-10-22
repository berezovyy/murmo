"""Constants behind the safety rules (harness/README.md). One place, so the
profile builder, the checker and the watchdog cannot disagree."""

from __future__ import annotations

import re

# Rule 1: the one key any profile carries. The fake server answers 403 to any
# other key, so a real credential that leaked in would never get a reply.
FAKE_KEY = 'murmo-harness-fake-key'

# Rule 7: real provider hostnames. Matched after ANSI and all whitespace are
# removed and the text is lower-cased, so a hostname wrapped across screen
# lines or split by colour codes still matches.
PROVIDER_HOST_PATTERNS: tuple[str, ...] = (
    r'api\.anthropic\.com',
    r'api\.openai\.com',
    r'[a-z0-9-]+\.openai\.azure\.com',
    r'bedrock-runtime[a-z0-9.-]*\.amazonaws\.com',
    r'generativelanguage\.googleapis\.com',
    r'openrouter\.ai',
    # Seen in earlier rounds' provider lists (hosts-r14 mac-smoke, load pty_base).
    r'api\.groq\.com',
    r'api\.mistral\.ai',
    r'api\.x\.ai',
    r'api\.z\.ai',
)
PROVIDER_HOST_RE = re.compile('|'.join(f'(?:{p})' for p in PROVIDER_HOST_PATTERNS))

# Rule 4: inherited variables that could carry a real credential or point a
# host at a real provider. Profiles are built from an allowlist anyway; the
# checker refuses a launch if any of these is present.
SCRUB_PREFIXES: tuple[str, ...] = (
    'ANTHROPIC_',
    'OPENAI_',
    'CLAUDE_CODE_OAUTH',
    'CLAUDE_CODE_USE_',
    'AWS_',
    'MURMO_',
    'AZURE_OPENAI',
    'GEMINI_',
    'GOOGLE_API',
    'OPENROUTER_',
)
SCRUB_NAMES: frozenset[str] = frozenset(
    {
        'GITHUB_TOKEN',
        'GH_TOKEN',
        'CLAUDECODE',
        'CLAUDE_CODE_ENTRYPOINT',
        'CLAUDE_CODE_CHILD_SESSION',
        'CLAUDE_CODE_PARENT_SESSION_ID',
        'CLAUDE_SESSION_ID',
        'CODEX_API_KEY',
        'CODEX_MANAGED_BY_NPM',
        'CODEX_SANDBOX',
        'CODEX_SANDBOX_NETWORK_DISABLED',
    }
)

# Variables the profile sets on purpose although they match a scrub prefix:
# the fake base URL and key, the harness's own run markers, and packed-product
# install pointers (not credentials; the packed integration sets them in HOME).
ALLOWED_SET = frozenset(
    {
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_API_KEY',
        'MURMO_FAKE_KEY',
        'MURMO_HARNESS_RUN',
        'MURMO_PACKAGE_ROOT',
        'MURMO_PLUGIN_TEST',
    }
)

# Rule 4: flags every profile sets, for every host (a Claude run also gets
# OpenCode's flags; one profile shape is easier to check than four).
REQUIRED_FLAGS: dict[str, str] = {
    'OPENCODE_CONFIG_PROJECT_DISABLE': 'true',
    'OPENCODE_DISABLE_CLAUDE_CODE_SKILLS': 'true',
    'OPENCODE_DISABLE_MODELS_FETCH': '1',
    'OPENCODE_DISABLE_AUTOUPDATE': '1',
    'OPENCODE_DISABLE_DEFAULT_PLUGINS': 'true',
    'DISABLE_AUTOUPDATER': '1',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1',
    # Claude 2.1.30x otherwise fetches downloads.claude.ai and git-clones the
    # official marketplace from GitHub at every start (blocked, but an attempt).
    'CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL': '1',
    'DISABLE_TELEMETRY': '1',
    'DISABLE_ERROR_REPORTING': '1',
    'PI_TELEMETRY': '0',
}

# Rule 4: every one of these must point inside the run's temporary folder.
CONFIG_PATH_VARS: tuple[str, ...] = (
    'HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'PI_CODING_AGENT_DIR',
    'OPENCODE_CONFIG_DIR',
    'OPENCODE_CONFIG',
    'npm_config_cache',
    'TMPDIR',
)

# Rule 10/11: the real-home folders the harness must leave untouched. The
# macOS sandbox denies host processes any access to them; the inventory check
# compares their metadata (never contents, never names in clear).
REAL_HOME_DIRS: tuple[str, ...] = ('.claude', '.codex', '.pi', '.config/opencode', '.agents', '.npm')
REAL_HOME_FILES: tuple[str, ...] = ('.claude.json',)


def is_scrubbed(name: str) -> bool:
    """True for an inherited variable a profile must not carry."""
    if name in ALLOWED_SET:
        return False
    return name in SCRUB_NAMES or name.startswith(SCRUB_PREFIXES)


def loopback_url(url: str) -> bool:
    return bool(re.fullmatch(r'http://127\.0\.0\.1:\d+(/.*)?', url))

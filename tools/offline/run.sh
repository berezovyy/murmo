#!/bin/sh
# Runs a command with outbound network blocked and throwaway agent homes.
# A fake-provider config does not keep a host offline (lesson 44), and
# isolating a host takes more than HOME (lesson 53), so tests never rely on
# either: the network is blocked at the OS level.
#
#   macOS: sandbox-exec with every network operation denied.
#   Linux: docker run --network none (no unshare fallback; docs/plan/20).
set -eu

repo=$(cd "$(dirname "$0")/../.." && pwd)

# Toolchains stay reachable after HOME moves (the image sets its own).
: "${CARGO_HOME:=$HOME/.cargo}"
: "${RUSTUP_HOME:=$HOME/.rustup}"
export CARGO_HOME RUSTUP_HOME

run_isolated() {
  profile=$(mktemp -d "${TMPDIR:-/tmp}/murmo-offline.XXXXXX")
  trap 'rm -rf "$profile"' EXIT INT TERM
  mkdir -p "$profile/codex" "$profile/claude" "$profile/pi" "$profile/xdg-config" \
    "$profile/xdg-data" "$profile/xdg-cache" "$profile/xdg-state"
  HOME="$profile" CODEX_HOME="$profile/codex" CLAUDE_CONFIG_DIR="$profile/claude" \
    PI_CODING_AGENT_DIR="$profile/pi" XDG_CONFIG_HOME="$profile/xdg-config" \
    XDG_DATA_HOME="$profile/xdg-data" XDG_CACHE_HOME="$profile/xdg-cache" \
    XDG_STATE_HOME="$profile/xdg-state" MURMO_OFFLINE=1 \
    "$@"
}

case "$(uname -s)" in
Darwin)
  run_isolated sandbox-exec -f "$repo/tools/offline/mac.sb" "$@"
  ;;
Linux)
  if [ "${MURMO_OFFLINE_CONTAINER:-}" = 1 ]; then
    run_isolated "$@"
  else
    # Rust and Node come from the image; crates from the registry that
    # tools/offline/fetch.sh filled; builds go to the shared target folder.
    image=${MURMO_OFFLINE_IMAGE:-murmo-offline:local}
    registry=${MURMO_CARGO_REGISTRY:-$CARGO_HOME/registry}
    target=${CARGO_TARGET_DIR:-$(node "$repo/tools/cargo.mjs" --print-target-dir)}
    mkdir -p "$registry" "$target"
    exec docker run --rm --network none --init --user "$(id -u):$(id -g)" \
      -e MURMO_OFFLINE_CONTAINER=1 -e CARGO_TARGET_DIR=/target \
      -v "$repo:$repo" -w "$repo" \
      -v "$registry:/cargo/registry" -v "$target:/target" \
      "$image" sh "$repo/tools/offline/run.sh" "$@"
  fi
  ;;
*)
  echo "offline runs support macOS and Linux only" >&2
  exit 2
  ;;
esac

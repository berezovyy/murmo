#!/bin/sh
# The only step that touches the network: install JS dependencies and fetch
# crates, so every later test step can run offline (tools/offline/run.sh).
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo"
pnpm install --frozen-lockfile
case "$(uname -s)" in
Darwin)
  node tools/cargo.mjs fetch --locked
  ;;
Linux)
  image=${MURMO_OFFLINE_IMAGE:-murmo-offline:local}
  registry=${MURMO_CARGO_REGISTRY:-${CARGO_HOME:-$HOME/.cargo}/registry}
  mkdir -p "$registry"
  docker run --rm --user "$(id -u):$(id -g)" \
    -v "$repo:$repo" -w "$repo" -v "$registry:/cargo/registry" \
    "$image" cargo fetch --locked
  ;;
esac

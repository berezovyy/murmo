#!/bin/sh
# Build linux-arm64 murmo-codex and murmo-plugin-host inside Debian Bookworm
# (glibc 2.36). Uses a nested target dir so darwin objects in the shared cache
# are not overwritten. Requires Docker; this machine is darwin-arm64.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="${1:-"$ROOT/dist/release/linux-bins"}"
CACHE="${CARGO_TARGET_DIR:-$(node "$ROOT/tools/cargo.mjs" --print-target-dir)}"
LINUX_TARGET="$CACHE/linux-arm64"
IMAGE="murmo-linux-build:bookworm"
CARGO_HOME_HOST="${CARGO_HOME:-$HOME/.cargo}"
# The image ships this toolchain without rustfmt and clippy, which
# rust-toolchain.toml also lists; naming the channel stops rustup from
# trying to fetch them inside the offline container.
TOOLCHAIN="$(sed -n 's/^channel = "\(.*\)"$/\1/p' "$ROOT/rust-toolchain.toml")"
mkdir -p "$DEST/linux-arm64" "$LINUX_TARGET"
docker build --platform linux/arm64 -t "$IMAGE" -f "$ROOT/tools/pack/Dockerfile.linux" "$ROOT/tools/pack"
docker run --rm --network none --platform linux/arm64 \
  -v "$ROOT:/src:ro" \
  -v "$LINUX_TARGET:/target" \
  -v "$CARGO_HOME_HOST/registry:/usr/local/cargo/registry:ro" \
  -v "$CARGO_HOME_HOST/git:/usr/local/cargo/git:ro" \
  -e CARGO_TARGET_DIR=/target \
  -e RUSTUP_TOOLCHAIN="$TOOLCHAIN" \
  "$IMAGE" \
  cargo build --release --locked --offline -p murmo-codex -p murmo-plugin-host
cp "$LINUX_TARGET/release/murmo-codex" "$DEST/linux-arm64/murmo-codex"
cp "$LINUX_TARGET/release/murmo-plugin-host" "$DEST/linux-arm64/murmo-plugin-host"
chmod 0755 "$DEST/linux-arm64/"*
echo "linux-arm64 helpers in $DEST/linux-arm64"

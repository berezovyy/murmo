# Linux image for offline test runs (tools/offline/run.sh) and fetches
# (tools/offline/fetch.sh). Bookworm (glibc 2.36): binaries built on newer
# images needed GLIBC_2.39 and would not start on Debian 12 (r11 H1, r12 H4).
FROM rust:1.99.0-slim-bookworm

ARG NODE_VERSION=24.18.0
ARG NODE_SHA256_X64=55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742
ARG NODE_SHA256_ARM64=58c9520501f6ae2b52d5b210444e24b9d0c029a58c5011b797bc1fe7105886f6

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git xz-utils \
 && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=x64; sum=$NODE_SHA256_X64 ;; \
      arm64) arch=arm64; sum=$NODE_SHA256_ARM64 ;; \
      *) echo "unsupported architecture" >&2; exit 1 ;; \
    esac; \
    file="node-v$NODE_VERSION-linux-$arch.tar.xz"; \
    curl -fsSLo "/tmp/$file" "https://nodejs.org/dist/v$NODE_VERSION/$file"; \
    echo "$sum  /tmp/$file" | sha256sum -c -; \
    tar -xJf "/tmp/$file" -C /usr/local --strip-components=1 --no-same-owner; \
    rm "/tmp/$file"; \
    node --version

RUN rustup component add rustfmt clippy

# Runs use --user <host uid>, so cargo's home (lock files, registry mount
# point) must be writable by anyone; the toolchain stays in /usr/local.
RUN mkdir -m 1777 /cargo
ENV CARGO_HOME=/cargo HOME=/tmp

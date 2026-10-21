# The Linux image for real-host runs (harness/README.md, safety rules 2 and 8).
#
# Built in a separate step; every container started from it runs with
# `--network none`. Host binaries are not baked in: they are installed into the
# shared harness cache and mounted read-only, so the same cache serves macOS
# and Linux and a host upgrade needs no image rebuild.
#
# `base` needs no network beyond pulling the pinned Node image: it already has
# Python 3.11 (the harness), git (the synthetic project's .git) and procps
# (the process table for cleanup). `tmux` adds tmux from Debian for the tmux
# driver on Linux; build it with `--target tmux` where apt may reach Debian's
# mirrors. Claude Code 2.1.304 already ran in node:24-bookworm with
# --network none in round 14 (r14-events-a).
FROM node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059 AS base
LABEL murmo-harness="1"
ENV PYTHONDONTWRITEBYTECODE=1 LANG=C.UTF-8

FROM base AS tmux
RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux \
 && rm -rf /var/lib/apt/lists/*

#!/bin/sh
# npm never writes its cache into the target HOME (r13 R3 / lesson 71).
# Bare `npx murmo setup` is supported but leaves npm's cache; uninstall never
# deletes a cache the user already had.
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# Release (phase 31) fills these. Empty skips the check. Env overrides.
EXPECTED_SHA512="${MURMO_TGZ_SHA512:-}"
EXPECTED_FINGERPRINT="${MURMO_KEY_FINGERPRINT:-}"

cache=$(mktemp -d "${TMPDIR:-/tmp}/murmo-npm.XXXXXXXX")
trap 'rm -rf "$cache"' EXIT HUP INT TERM

tgz=
for f in "$base"/murmo-*.tgz; do
  [ -f "$f" ] || continue
  tgz=$f
  break
done

if [ -z "$tgz" ]; then
  echo "murmo install: no murmo-*.tgz next to this script" >&2
  echo "  one-liner (leaves no ~/.npm): sh -c 'c=\$(mktemp -d); trap \"rm -rf \\\"\$c\\\"\" EXIT; npm exec --yes --cache \"\$c\" --package <name>@<version> -- murmo setup'" >&2
  echo "  bare npx <name> setup leaves npm's cache" >&2
  exit 2
fi

if [ -n "$EXPECTED_SHA512" ]; then
  if command -v shasum >/dev/null 2>&1; then
    got=$(shasum -a 512 "$tgz" | awk '{print $1}')
  else
    got=$(sha512sum "$tgz" | awk '{print $1}')
  fi
  if [ "$got" != "$EXPECTED_SHA512" ]; then
    echo "murmo install: SHA-512 mismatch for $tgz" >&2
    echo "  expected $EXPECTED_SHA512" >&2
    echo "  got      $got" >&2
    exit 1
  fi
fi

if [ -n "$EXPECTED_FINGERPRINT" ]; then
  echo "murmo install: expected key fingerprint $EXPECTED_FINGERPRINT" >&2
fi

npm exec --offline --yes --cache "$cache" --package "$tgz" -- murmo "$@"

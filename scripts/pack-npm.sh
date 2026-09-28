#!/usr/bin/env bash
# Builds the two public npm packages from the committed HEAD.
# Usage: scripts/pack-npm.sh <out-dir>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$(mkdir -p "${1:?usage: pack-npm.sh <out-dir>}" && cd "$1" && pwd)"
WORK="$(mktemp -d)"

cleanup() {
  if command -v trash >/dev/null; then
    trash "$WORK" 2>/dev/null || true
  fi
}
trap cleanup EXIT

shopt -s nullglob
existing=("$OUT"/*.tgz)
if (( ${#existing[@]} != 0 )); then
  echo "pack-npm: output directory already contains .tgz files: $OUT" >&2
  exit 1
fi

git -C "$ROOT" archive --format=tar HEAD | tar -x -C "$WORK"
VERSION="$(node -p 'require(process.argv[1]).version' "$WORK/packages/sdk/ts/package.json")"
CLI_VERSION="$(node -p 'require(process.argv[1]).version' "$WORK/apps/cli/package.json")"
[[ "$VERSION" == "$CLI_VERSION" ]] || { echo "pack-npm: sdk $VERSION != cli $CLI_VERSION" >&2; exit 1; }
PACKED="$WORK/packed"
mkdir -p "$PACKED"

(
  cd "$WORK"
  if [[ -d "$ROOT/.pnpm-store/v10/index" ]]; then
    if ! pnpm install --offline --frozen-lockfile --store-dir "$ROOT/.pnpm-store/v10"; then
      pnpm install --frozen-lockfile
    fi
  else
    pnpm install --frozen-lockfile
  fi
  pnpm run build
  pnpm --filter boilpayment-sdk pack --pack-destination "$PACKED"
  pnpm --filter boilpayment pack --pack-destination "$PACKED"
)

tarballs=("$PACKED"/*.tgz)
if (( ${#tarballs[@]} != 2 )); then
  echo "pack-npm: expected exactly 2 tarballs, found ${#tarballs[@]}" >&2
  exit 1
fi

expected=(
  "$PACKED/boilpayment-$VERSION.tgz"
  "$PACKED/boilpayment-sdk-$VERSION.tgz"
)
for file in "${expected[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "pack-npm: missing expected tarball: $file" >&2
    exit 1
  fi
done

VERIFY="$WORK/verify"
mkdir -p "$VERIFY/cli" "$VERIFY/sdk"
tar -xzf "$PACKED/boilpayment-$VERSION.tgz" -C "$VERIFY/cli"
tar -xzf "$PACKED/boilpayment-sdk-$VERSION.tgz" -C "$VERIFY/sdk"

internal_pattern='boilpayment-(core|credits|lifecycle|refund|usage|webhook|notify|cs|schema-postgres|stripe|toss|portone|polar)'
if LC_ALL=C grep -ERn --binary-files=without-match "$internal_pattern" "$VERIFY"; then
  echo "pack-npm: a shipped file contains a bare internal package specifier" >&2
  exit 1
fi

node - "$VERIFY/cli/package/package.json" "$VERIFY/sdk/package/package.json" "$WORK/packages/sdk/ts/package.json" "$VERSION" <<'NODE'
const fs = require('node:fs');

const cli = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const sdk = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const expectedSdkDependencies = JSON.parse(fs.readFileSync(process.argv[4], 'utf8')).dependencies;
const version = process.argv[5];

if (cli.dependencies?.['boilpayment-sdk'] !== version) {
  throw new Error(`packed CLI must depend on boilpayment-sdk ${version}`);
}
if (Object.keys(sdk.dependencies ?? {}).some((name) => name.startsWith('boilpayment'))
  || JSON.stringify(sdk.dependencies) !== JSON.stringify(expectedSdkDependencies)) {
  throw new Error(`unexpected SDK dependencies: ${JSON.stringify(sdk.dependencies)}`);
}
NODE

cp "${expected[@]}" "$OUT/"
published=("$OUT"/*.tgz)
if (( ${#published[@]} != 2 )); then
  echo "pack-npm: expected exactly 2 output tarballs, found ${#published[@]}" >&2
  exit 1
fi

printf '%s\n' "built ${published[*]}"

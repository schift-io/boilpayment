#!/usr/bin/env bash
# For every package with both ts/examples/smoke.ts and py/examples/smoke.py, run both, normalize
# the output to erase pure language-convention differences (ISO tz suffix, bool casing,
# camelCase vs snake_case keys, JSON separator whitespace, array-literal spacing), diff, and
# report PASS/DIFF per package. Also runs examples/e2e round-trip both ways.
#
# schema-postgres is always skipped: its smokes print DB-generated UUIDs, language-tagged customer ids and
# migration state, so stdout is not comparable. Store parity is enforced by the InMemory-vs-Postgres
# scenario test in packages/schema-postgres/{ts/test,py/tests} instead.
#
# Exit 0 iff every checked package is PASS. Exit 1 on any DIFF or run failure.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TSX="$ROOT/apps/cli/node_modules/.bin/tsx"
PYBIN="$ROOT/.venv/bin/python"

if [[ ! -x "$TSX" ]]; then
  echo "parity.sh: tsx not found at $TSX (pnpm install not run?)" >&2
  exit 1
fi
if [[ ! -x "$PYBIN" ]]; then
  echo "parity.sh: python not found at $PYBIN (uv sync not run?)" >&2
  exit 1
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# Normalize representation only; business values must remain distinguishable.
normalize() {
  if ! node "$ROOT/scripts/parity-normalize.mjs" <"$1" >"$2" 2>"$WORKDIR/normalize.err"; then
    echo "parity.sh: normalizer crashed on $1" >&2
    cat "$WORKDIR/normalize.err" >&2
    exit 2
  fi
}

# --- discover packages -------------------------------------------------------
declare -a PKG_NAMES=()
declare -a PKG_TS=()
declare -a PKG_PY=()

while IFS= read -r ts_smoke; do
  pkg_ts_dir="$(dirname "$(dirname "$ts_smoke")")" # .../<pkg>/ts
  pkg_dir="$(dirname "$pkg_ts_dir")"                # .../<pkg>
  py_smoke="$pkg_dir/py/examples/smoke.py"
  [[ -f "$py_smoke" ]] || continue
  pkg_name="${pkg_dir#"$ROOT"/packages/}"
  if [[ "$pkg_name" == "schema-postgres" ]]; then
    echo "SKIP  $pkg_name (store parity is a test, not a stdout diff — see header)"
    continue
  fi
  PKG_NAMES+=("$pkg_name")
  PKG_TS+=("$ts_smoke")
  PKG_PY+=("$py_smoke")
done < <(find "$ROOT/packages" -type f -path '*/ts/examples/smoke.ts' | sort)

# --- run + diff ---------------------------------------------------------------
FAILED=0
RESULTS=""

run_pair() {
  local label="$1" ts_cmd="$2" py_cmd="$3"
  local ts_out="$WORKDIR/${label//\//_}.ts.out"
  local py_out="$WORKDIR/${label//\//_}.py.out"
  local ts_norm="$WORKDIR/${label//\//_}.ts.norm"
  local py_norm="$WORKDIR/${label//\//_}.py.norm"
  local ts_err py_err ts_rc py_rc

  ts_err="$WORKDIR/${label//\//_}.ts.err"
  py_err="$WORKDIR/${label//\//_}.py.err"

  eval "$ts_cmd" >"$ts_out" 2>"$ts_err"
  ts_rc=$?
  eval "$py_cmd" >"$py_out" 2>"$py_err"
  py_rc=$?

  if [[ $ts_rc -ne 0 || $py_rc -ne 0 ]]; then
    RESULTS+="FAIL  $label (ts exit=$ts_rc, py exit=$py_rc)\n"
    if [[ $ts_rc -ne 0 ]]; then echo "  --- $label ts stderr ---"; sed 's/^/    /' "$ts_err"; fi
    if [[ $py_rc -ne 0 ]]; then echo "  --- $label py stderr ---"; sed 's/^/    /' "$py_err"; fi
    FAILED=1
    return
  fi

  normalize "$ts_out" "$ts_norm"
  normalize "$py_out" "$py_norm"

  if diff -q "$ts_norm" "$py_norm" >/dev/null; then
    RESULTS+="PASS  $label\n"
  else
    RESULTS+="DIFF  $label\n"
    FAILED=1
    echo "  --- $label diff (normalized ts vs py) ---"
    diff "$ts_norm" "$py_norm" | sed 's/^/    /' | head -40
  fi
}

for i in "${!PKG_NAMES[@]}"; do
  run_pair "${PKG_NAMES[$i]}" \
    "\"$TSX\" \"${PKG_TS[$i]}\"" \
    "\"$PYBIN\" \"${PKG_PY[$i]}\""
done

# --- e2e round-trip ------------------------------------------------------------
E2E_TS="$ROOT/examples/e2e/round-trip.ts"
E2E_PY="$ROOT/examples/e2e/round_trip.py"
if [[ -f "$E2E_TS" && -f "$E2E_PY" ]]; then
  run_pair "examples/e2e" \
    "\"$TSX\" \"$E2E_TS\"" \
    "\"$PYBIN\" \"$E2E_PY\""
else
  echo "SKIP  examples/e2e (round-trip.ts / round_trip.py not found)"
fi

# --- summary ---------------------------------------------------------------
echo ""
echo "=== parity summary ==="
printf "%b" "$RESULTS"

exit $FAILED

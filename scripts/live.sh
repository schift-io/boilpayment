#!/usr/bin/env bash
# Keys-free "live" round trips: real provider code over real HTTP against local mocks.
# Requires: pnpm build done, .venv synced, `stripe-mock` on PATH (brew install stripe/stripe-mock/stripe-mock).
set -u
cd "$(dirname "$0")/.."
TSX=apps/cli/node_modules/.bin/tsx; PY=.venv/bin/python; fail=0
run() {
  local label=$1 out last status=0
  shift
  out=$("$@" 2>&1) || status=$?
  last=$(printf '%s\n' "$out" | tail -1)
  if [[ $status -eq 0 && "$last" == *" ROUND TRIP OK" ]]; then
    echo "PASS  $label"
  else
    echo "FAIL  $label (exit $status)"
    printf '%s\n' "$out" | tail -15
    fail=1
  fi
}
# Sourcing exposes only the result gate for isolated subprocess regression tests.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then return; fi
echo "Local mock HTTP checks and isolated CS-server checks; not real-provider evidence."
if command -v stripe-mock >/dev/null; then
  stripe-mock -http-port 12111 -https-port 12112 >/dev/null 2>&1 & SM=$!; sleep 1
  run "stripe ts" $TSX examples/live/stripe-mock.ts; run "stripe py" $PY examples/live/stripe_mock.py
  run "stripe native renewal ts" $TSX examples/e2e/native-renewal-stripe-mock.ts; kill $SM
else echo "SKIP  stripe (stripe-mock not installed)"; fi
for p in toss portone polar; do
  for lang in ts py; do
    node tools/mocks/$p/server.mjs >/dev/null 2>&1 & MP=$!; sleep 1
    if [[ $lang == ts ]]; then run "$p ts" $TSX examples/live/$p-mock.ts; else run "$p py" $PY examples/live/${p}_mock.py; fi
    kill $MP; sleep 0.3
  done
done
exit $fail

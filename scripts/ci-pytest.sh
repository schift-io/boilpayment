#!/usr/bin/env bash
# Preserve pytest's status, including exit 5 (no tests collected).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

exec "$ROOT/.venv/bin/pytest" packages -q

#!/usr/bin/env bash
# security/check-dynamic-patterns.sh — flag risky dynamic-execution patterns
# in production source (src/). Tests, labs, and scripts are allowed to use
# these patterns.
#
# Patterns:
#   - bare `eval(`
#   - `new Function(`
#   - dynamic `import(<non-literal>)` — flagged as a warning (not blocking)
#     because we use a heuristic that may have false positives.
#
# Exit 1 on any blocking pattern in src/core, src/engine, src/game, src/shared.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

ROOTS=("src/core" "src/engine" "src/game" "src/shared")
FAILED=0

run_grep() {
  local label="$1"
  local pattern="$2"
  local severity="$3"
  local hits
  if hits=$(git --no-pager grep -nE "$pattern" -- "${ROOTS[@]}" 2>/dev/null); then
    if [ "$severity" = "error" ]; then
      echo "[ERROR] ${label}:"
      FAILED=1
    else
      echo "[WARN] ${label}:"
    fi
    echo "$hits" | sed 's/^/  /'
  fi
}

run_grep "Bare eval()" '\beval\(' "error"
run_grep "new Function(" '\bnew Function\(' "error"
run_grep "Dynamic import() with non-literal" "\bimport\([^'\"]" "warn"

if [ "$FAILED" -ne 0 ]; then
  echo ""
  echo "[ERROR] check-dynamic-patterns: forbidden patterns in production source. Refactor or move into a lab."
  exit 1
fi

echo "[INFO] check-dynamic-patterns: clean."
exit 0

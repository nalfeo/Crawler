#!/usr/bin/env bash
set -euo pipefail
export CI=1

echo "🔍 Step 1-2/3: Type checking + Linting (parallel)..."
npx tsc --noEmit &
TSC_PID=$!
npx eslint src/ tests/ scripts/ --max-warnings 0 --cache --cache-location .eslintcache &
ESLINT_PID=$!
trap 'kill "$TSC_PID" "$ESLINT_PID" 2>/dev/null || true' EXIT

tsc_status=0
eslint_status=0
wait $TSC_PID || tsc_status=$?
wait $ESLINT_PID || eslint_status=$?
trap - EXIT

if [ "$tsc_status" -ne 0 ]; then
  exit "$tsc_status"
fi

if [ "$eslint_status" -ne 0 ]; then
  exit "$eslint_status"
fi

echo "🔍 Step 3/3: Unit tests..."
npx vitest run --project unit --reporter=dot

echo "✅ Fast verification passed."

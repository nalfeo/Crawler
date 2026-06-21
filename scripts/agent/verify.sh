#!/usr/bin/env bash
set -euo pipefail
export CI=1

echo "🔍 Step 1-2/8: Type checking + Linting (parallel)..."
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

echo "🔍 Step 3/8: Format checking..."
npx prettier --check --log-level warn "src/**/*.ts" "tests/**/*.ts" "scripts/**/*.ts"

echo "🔍 Step 4/8: Dead code detection..."
npx knip || echo "⚠️  Knip found unused exports (non-blocking for now)"

echo "🔍 Step 5/8: Unit tests with coverage..."
# Scope coverage to the unit project to match CI (ci.yml test-unit job).
# Without --project unit, vitest also runs the e2e project, whose globalSetup
# spawns a lab server; if that server is slow/unavailable the unhandled error
# aborts coverage collection and reports a false 0% for every file.
npx vitest run --project unit --coverage --reporter=dot

echo "🔍 Step 6/8: Integration tests..."
if [ ! -d tests/integration ]; then
  echo "ℹ️  No integration tests directory found; skipping."
# `find -print -quit` emits only the first match; grep confirms at least one file exists.
elif find tests/integration -type f -name '*.test.ts' -print -quit | grep -q .; then
  npx vitest run --project integration --reporter=dot
else
  echo "ℹ️  No integration tests found; skipping."
fi

echo "🔍 Step 7/8: Headless Floor 1 completion gate..."
npx vitest run --project headless --reporter=dot

echo "🔍 Step 8/8: Building..."
npx vite build

echo "✅ Full verification passed."

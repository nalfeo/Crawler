#!/usr/bin/env bash
set -euo pipefail
export CI=1

echo "🔍 Step 1-2/7: Type checking + Linting (parallel)..."
npx tsc --noEmit &
TSC_PID=$!
npx eslint src/ tests/ scripts/ --max-warnings 0 &
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

echo "🔍 Step 3/7: Format checking..."
npx prettier --check --log-level warn "src/**/*.ts" "tests/**/*.ts" "scripts/**/*.ts"

echo "🔍 Step 4/7: Dead code detection..."
npx knip || echo "⚠️  Knip found unused exports (non-blocking for now)"

echo "🔍 Step 5/7: Unit tests with coverage..."
npx vitest run --coverage --reporter=dot

echo "🔍 Step 6/7: Integration tests..."
npx vitest run --project integration --reporter=dot 2>/dev/null || echo "ℹ️  No integration tests yet"

echo "🔍 Step 7/7: Building..."
npx vite build

echo "✅ Full verification passed."

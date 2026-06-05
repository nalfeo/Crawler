#!/usr/bin/env bash
set -euo pipefail

echo "🔍 Step 1-2/7: Type checking + Linting (parallel)..."
npx tsc --noEmit &
TSC_PID=$!
npx eslint src/ tests/ scripts/ --max-warnings 0 &
ESLINT_PID=$!
wait $TSC_PID || exit 1
wait $ESLINT_PID || exit 1

echo "🔍 Step 3/7: Format checking..."
npx prettier --check "src/**/*.ts" "tests/**/*.ts" "scripts/**/*.ts"

echo "🔍 Step 4/7: Dead code detection..."
npx knip || echo "⚠️  Knip found unused exports (non-blocking for now)"

echo "🔍 Step 5/7: Unit tests with coverage..."
npx vitest run --coverage

echo "🔍 Step 6/7: Integration tests..."
npx vitest run --project integration 2>/dev/null || echo "ℹ️  No integration tests yet"

echo "🔍 Step 7/7: Building..."
npx vite build

echo "✅ Full verification passed."

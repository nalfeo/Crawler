#!/usr/bin/env bash
set -euo pipefail

echo "🔍 Step 1-2/3: Type checking + Linting (parallel)..."
npx tsc --noEmit &
TSC_PID=$!
npx eslint src/ tests/ scripts/ --max-warnings 0 &
ESLINT_PID=$!
wait $TSC_PID || exit 1
wait $ESLINT_PID || exit 1

echo "🔍 Step 3/3: Unit tests..."
npx vitest run --project unit --reporter=verbose

echo "✅ Fast verification passed."

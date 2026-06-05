#!/usr/bin/env bash
set -euo pipefail

echo "🔍 Step 1/3: Type checking..."
npx tsc --noEmit

echo "🔍 Step 2/3: Linting..."
npx eslint src/ tests/ scripts/ --max-warnings 0

echo "🔍 Step 3/3: Unit tests..."
npx vitest run --project unit --reporter=verbose

echo "✅ Fast verification passed."

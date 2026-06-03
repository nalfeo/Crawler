#!/usr/bin/env bash
set -euo pipefail

echo "🔧 Preflight: Installing dependencies..."
npm ci --prefer-offline --silent

echo "🔍 Preflight: Type checking..."
npx tsc --noEmit

echo "✅ Preflight complete. Environment is ready."

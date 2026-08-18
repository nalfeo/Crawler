#!/usr/bin/env bash
set -euo pipefail
export CI=1

echo "🔍 Step 1-2/10: Type checking + Linting (parallel)..."
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

echo "🔍 Step 3/10: Format checking..."
npx prettier --check --log-level warn "src/**/*.ts" "tests/**/*.ts" "scripts/**/*.ts"

echo "🔍 Step 4/10: Dead code detection..."
# Knip scans the current typed source/test/sprite-script scope for unused files,
# exports, and dependencies (~5-10s). It is ADVISORY in CI (its job is
# non-blocking) and advisory here too, so gate it behind an opt-in flag to keep
# the default full-verify inner loop lean. Run it — e.g. when refactoring or
# removing exports/files — with VERIFY_KNIP=1. CI's advisory knip job is
# unaffected either way. (Mirrors the VERIFY_COVERAGE / VERIFY_FULL opt-ins below.)
if [ "${VERIFY_KNIP:-}" = "1" ]; then
  npm run lint:dead-code || echo "⚠️  Knip found dead code (non-blocking)"
else
  echo "   ⏭️  Skipped (advisory in CI). Set VERIFY_KNIP=1 to run locally — do so when refactoring files/exports."
fi

echo "🔍 Step 5/10: Guard + review-ledger tests..."
npm run test:guards

echo "🔍 Step 5b/10: Orphaned-system wiring guard..."
# Deterministic architecture guard: every *System exported from src/core|src/game
# must be referenced by a REAL runtime pipeline (see WIRING_SITES) or be on the
# documented allowlist. Catches the class of bug where spawnerSystem shipped
# inert because only its lab force-called it (ADR 0039).
npx tsx scripts/agent/health/orphaned-systems.ts

echo "🔍 Step 5c/10: Equipment art coverage ratchet..."
# Deterministic art guard: every wired equipment piece (legacy catalog
# equippables + the Floor 2 generated-equipment reward pool) must resolve to
# real approved art through the same resolveItemSprite the panels call. Gaps
# already recorded in the shrink-only baseline pass; a NEW gap fails, so
# equipment can no longer ship wired-but-un-arted and be discovered by eye.
npx tsx scripts/agent/health/check-equipment-art-coverage.ts

echo "🔍 Step 5d/10: Sprite name taxonomy guard..."
# Deterministic naming guard: every generated brief id must be a BARE concept
# with `-var-N` variants only. A lineage-tagged id (`rat-v1`) silently splits a
# concept into a second variant bucket in `loadGeneratedManifest`, stranding
# approved art that `pickGeneratedVariant` can never draw.
npx tsx scripts/sprites/normalize-sprite-names.ts --check

# v8 coverage instrumentation roughly 5x's the unit-suite wall time (~27s ->
# ~140s on a typical dev box). Coverage thresholds are authoritatively enforced
# in CI (ci.yml `test-unit` job) on every PR, so this local pre-commit gate runs
# the unit suite WITHOUT coverage by default to keep the inner loop fast. Opt
# back in for a full local check with VERIFY_COVERAGE=1, or run the focused
# `npm run verify:coverage`.
#
# --project unit matches CI scope: without it, vitest also runs the e2e project,
# whose globalSetup spawns a lab server; if that server is slow/unavailable the
# unhandled error aborts coverage collection and reports a false 0% for every file.
if [ "${VERIFY_COVERAGE:-}" = "1" ]; then
  echo "🔍 Step 6/10: Unit tests with coverage..."
  npx vitest run --project unit --coverage --reporter=dot
else
  echo "🔍 Step 6/10: Unit tests (coverage enforced in CI; set VERIFY_COVERAGE=1 for a local coverage gate)..."
  npx vitest run --project unit --reporter=dot
fi

echo "🔍 Step 7/10: Integration tests..."
if [ ! -d tests/integration ]; then
  echo "ℹ️  No integration tests directory found; skipping."
# `find -print -quit` emits only the first match; grep confirms at least one file exists.
elif find tests/integration -type f -name '*.test.ts' -print -quit | grep -q .; then
  # NOTE: sprite pipeline integration tests (batch-cli, generate-one, judge-*, run-full,
  # sidecar-lifecycle, synth-to-generate, weapons-pipeline, tests/integration/sprites/)
  # live in the `sprites` project now and are NOT included here. Run them with:
  #   npm run test:sprites
  npx vitest run --project integration --reporter=dot
else
  echo "ℹ️  No integration tests found; skipping."
fi

echo "🔍 Step 7b/10: Sprite pipeline tests..."
npx vitest run --project sprites --reporter=dot

# The Headless Floor 1 gate replays a full ~20k-frame deterministic sim per
# losing (seed, weapon) and is the single slowest step (~300s in CI, the CI
# long-pole). It is authoritatively enforced by the REQUIRED `test-headless`
# job in CI (ci.yml) on every code PR, so this local pre-commit gate SKIPS it by
# default to keep the inner loop fast (mirrors the VERIFY_COVERAGE opt-in above).
# Opt back in for a full local run — e.g. when touching core/game AI/balance —
# with VERIFY_FULL=1.
if [ "${VERIFY_FULL:-}" = "1" ]; then
  echo "🔍 Step 8/10: Headless Floor 1 completion gate (VERIFY_FULL=1)..."
  npx vitest run --project headless --reporter=dot
else
  echo "🔍 Step 8/10: Headless Floor 1 gate — deferred to the required CI job (set VERIFY_FULL=1 to run locally)..."
fi

echo "🔍 Step 9/10: PR prerequisites (run early, before create_pull_request)..."
npm run verify:pr-prereqs

echo "🔍 Step 10/10: Building..."
npx vite build

echo "✅ Full verification passed."

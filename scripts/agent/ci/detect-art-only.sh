#!/usr/bin/env bash
#
# detect-art-only.sh — detect change scope and emit art_only + docs_only +
# gameplay_safe flags.
#
# art_only=true  — every changed file is under the approved-art surface:
#   - public/assets/generated/**        (sprites + manifest.json)
#   - src/shared/data/sprite-catalog.json
# When art-only, CI skips heavy gameplay gates (integration, headless, e2e, build)
# but still runs typecheck/lint/format/unit.
#
# docs_only=true — every changed file is a markdown or plain-text file (*.md,
# *.txt) outside of src/. When docs-only, CI skips ALL heavy gates (including
# typecheck/lint/unit) because markdown cannot contain game logic.
#
# gameplay_safe=true — every changed file provably cannot change the deterministic
# Floor-1 simulation the headless gate runs (src/engine rendering, src/labs,
# tests/e2e, docs, *.md/*.txt, public/**). The headless runner imports only
# src/core, src/shared and src/game/ai — never src/engine (ESLint layer rule) —
# so these surfaces cannot alter the sim outcome. ci.yml uses this to skip the
# 306s headless job on PULL_REQUESTS ONLY; main-push always runs it, preserving
# an observe-after-merge backstop in case the allowlist is ever wrong.
#
# Output: writes all flags to $GITHUB_OUTPUT (when set) and stdout.
# Test hook: SCOPE_FILES_OVERRIDE (newline-separated paths) classifies that list
# directly instead of deriving it from git — used by the deterministic unit test.
# Fail-safe: any ambiguity (no base, no changed files, detached history) yields
# false for every flag, so the full suite runs. This script never blocks CI.

set -euo pipefail

emit_output() {
  local name="$1" value="$2"
  echo "${name}=${value}"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "${name}=${value}" >>"$GITHUB_OUTPUT"
  fi
}

# Emit all scope flags at once (fail-safe path uses this for early exits).
emit_all() {
  emit_output art_only "$1"
  emit_output docs_only "$2"
  emit_output gameplay_safe "$3"
  emit_output sprites_only "$4"
  emit_output sprites_touched "$5"
}

# Resolve the set of changed files. Normally derived from git; the
# SCOPE_FILES_OVERRIDE test hook (newline-separated paths) lets the deterministic
# unit test drive the classifier without constructing a git scenario. Presence is
# detected with ${VAR+x}, NOT -n, so an explicitly empty override is honored as an
# empty change set (→ fail-safe all-false below) rather than silently falling back
# to git-based diffing.
if [ -n "${SCOPE_FILES_OVERRIDE+x}" ]; then
  changed="${SCOPE_FILES_OVERRIDE:-}"
  echo "Using SCOPE_FILES_OVERRIDE (test hook)." >&2
else
  # Resolve the comparison base.
  base_ref=""
  if [ -n "${GITHUB_BASE_REF:-}" ]; then
    # Pull request: compare against the PR's base branch.
    git fetch --no-tags origin "$GITHUB_BASE_REF" >/dev/null 2>&1 || true
    base_ref="origin/${GITHUB_BASE_REF}"
  elif [ -n "${EVENT_BEFORE:-}" ] && [ "${EVENT_BEFORE}" != "0000000000000000000000000000000000000000" ]; then
    # Push: compare against the commit that was there before the push.
    base_ref="${EVENT_BEFORE}"
  else
    base_ref="$(git rev-parse HEAD^ 2>/dev/null || true)"
  fi

  if [ -z "$base_ref" ]; then
    echo "No comparison base available — running full CI." >&2
    emit_all false false false false false
    exit 0
  fi

  changed="$(git diff --name-only "${base_ref}...HEAD" 2>/dev/null || true)"
  if [ -z "$changed" ]; then
    # Two-dot fallback for non-merge-base histories (e.g. force-push).
    changed="$(git diff --name-only "${base_ref}" HEAD 2>/dev/null || true)"
  fi

  echo "Comparison base: ${base_ref}" >&2
fi

echo "Changed files:" >&2
echo "${changed:-<none>}" >&2

# Fail-safe: no changed files (or an all-whitespace override) runs the full suite.
if [ -z "$(printf '%s' "$changed" | tr -d '[:space:]')" ]; then
  emit_all false false false false false
  exit 0
fi

# art_only: every changed file is under the approved-art surface.
art_only=true
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    public/assets/generated/*) ;;
    src/shared/data/sprite-catalog.json) ;;
    *)
      art_only=false
      break
      ;;
  esac
done <<<"$changed"

# docs_only: every changed file is a markdown or plain-text file outside src/.
# src/** is never docs (game logic can live there), so we break immediately if
# a src/ path appears.
docs_only=true
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    src/*) docs_only=false; break ;;
    *.md) ;;
    *.txt) ;;
    *) docs_only=false; break ;;
  esac
done <<<"$changed"

# gameplay_safe: every changed file is provably unable to change the deterministic
# Floor-1 simulation. Allowlist = surfaces the headless runner never imports
# (src/engine, src/labs), plus e2e tests, docs, static assets, sprite-pipeline
# scripts/tests, and sprite catalog plumbing. Anything else — src/core, src/game,
# most src/shared, tests/headless, non-sprite scripts, .github, root config —
# forces the gate to run. Consumed by ci.yml to skip the headless job on
# pull_requests only.
# The sprite pipeline (scripts/sprites/, tests/unit/sprites/, tests/integration/sprites/,
# and the 8 root pipeline integration tests) is also safe: the headless runner imports
# only src/core, src/shared, src/game/ai and never touches scripts/sprites/.
gameplay_safe=true
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    src/engine/*) ;;
    src/labs/*) ;;
    tests/e2e/*) ;;
    docs/*) ;;
    public/*) ;;
    src/shared/data/sprite-catalog.json) ;;
    package.json) ;;
    scripts/agent/ci/detect-art-only.sh) ;;
    tests/unit/detect-change-scope.test.ts) ;;
    scripts/sprites/*) ;;
    tests/unit/sprites/*) ;;
    tests/integration/sprites/*) ;;
    tests/integration/batch-cli.test.ts) ;;
    tests/integration/generate-one.test.ts) ;;
    tests/integration/judge-budget-cache.test.ts) ;;
    tests/integration/judge-pipeline.test.ts) ;;
    tests/integration/run-full.test.ts) ;;
    tests/integration/sidecar-lifecycle.test.ts) ;;
    tests/integration/synth-to-generate.test.ts) ;;
    tests/integration/weapons-pipeline.test.ts) ;;
    *.md) ;;
    *.txt) ;;
    *)
      gameplay_safe=false
      break
      ;;
  esac
done <<<"$changed"

# sprites_only: every changed file is in the sprite generation/editing pipeline.
# When true, CI skips game tests (unit, integration, headless, e2e) and runs only
# the dedicated sprites test project.
# Sprite surface: scripts/sprites/, tests/unit/sprites/, tests/integration/sprites/,
# plus the 8 root pipeline integration tests that exercise the full pipeline E2E.
sprites_only=true
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    scripts/sprites/*) ;;
    tests/unit/sprites/*) ;;
    tests/integration/sprites/*) ;;
    tests/integration/batch-cli.test.ts) ;;
    tests/integration/generate-one.test.ts) ;;
    tests/integration/judge-budget-cache.test.ts) ;;
    tests/integration/judge-pipeline.test.ts) ;;
    tests/integration/run-full.test.ts) ;;
    tests/integration/sidecar-lifecycle.test.ts) ;;
    tests/integration/synth-to-generate.test.ts) ;;
    tests/integration/weapons-pipeline.test.ts) ;;
    *)
      sprites_only=false
      break
      ;;
  esac
done <<<"$changed"

# sprites_touched: at least one changed file is in the sprite pipeline surface.
# Used to gate test-sprites in CI: if no sprite file changed, skip the sprite test
# job (a pure game change cannot break pipeline tests and vice versa).
sprites_touched=false
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    scripts/sprites/*) sprites_touched=true; break ;;
    tests/unit/sprites/*) sprites_touched=true; break ;;
    tests/integration/sprites/*) sprites_touched=true; break ;;
    tests/integration/batch-cli.test.ts) sprites_touched=true; break ;;
    tests/integration/generate-one.test.ts) sprites_touched=true; break ;;
    tests/integration/judge-budget-cache.test.ts) sprites_touched=true; break ;;
    tests/integration/judge-pipeline.test.ts) sprites_touched=true; break ;;
    tests/integration/run-full.test.ts) sprites_touched=true; break ;;
    tests/integration/sidecar-lifecycle.test.ts) sprites_touched=true; break ;;
    tests/integration/synth-to-generate.test.ts) sprites_touched=true; break ;;
    tests/integration/weapons-pipeline.test.ts) sprites_touched=true; break ;;
  esac
done <<<"$changed"

emit_all "$art_only" "$docs_only" "$gameplay_safe" "$sprites_only" "$sprites_touched"

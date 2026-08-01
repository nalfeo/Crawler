#!/usr/bin/env bash
#
# detect-art-only.sh — detect change scope and emit orthogonal impact flags
# (art_only, docs_only, gameplay_safe, sim_touched, coverage_touched, visual
# surfaces, and security-impact flags).
#
# art_only=true  — every changed file is under the approved-art surface:
#   - public/assets/generated/**        (sprite PNGs + per-asset manifest shards
#                                        under entries/; the aggregate manifest.json
#                                        is a gitignored build artifact, never in a diff)
#   - src/shared/data/sprite-catalog.json
# When art-only, CI skips heavy gameplay gates (integration, headless, e2e, build)
# but still runs typecheck/lint/format/unit.
#
# docs_only=true — every changed file is under the documentation/governance
# surface (`docs/**`, `.specify/specs/**`, `AGENTS.md`) or is a markdown/plain-
# text file (*.md, *.txt) outside of src/. When docs-only, CI skips ALL heavy
# gates (including typecheck/lint/unit) because these surfaces do not contain
# shipped game logic.
#
# gameplay_safe=true — every changed file provably cannot change the deterministic
# Floor-1 simulation the headless gate runs (src/engine rendering, src/labs,
# tests/e2e, docs, *.md/*.txt, public/**). The headless runner imports only
# src/core, src/shared and src/game/ai — never src/engine (ESLint layer rule) —
# so these surfaces cannot alter the sim outcome. ci.yml uses this to skip the
# 306s headless job on PULL_REQUESTS ONLY; main-push always runs it, preserving
# an observe-after-merge backstop in case the allowlist is ever wrong.
#
# sim_touched=true — at least one changed file is in the simulation-critical surface.
# Fail-closed: unknown/unclassified paths set sim_touched=true (run the gate).
# ci.yml uses this to gate the headless Floor-1 job on PRs: headless runs only
# when sim_touched=true; main-push and schedule always run it as a backstop.
#
# coverage_touched=true — at least one changed file is in the unit-test coverage
# surface. Fail-closed: unknown/unclassified paths set coverage_touched=true.
# ci.yml uses this to gate the advisory unit-coverage job on PRs.
#
# dependencies_touched=true — at least one changed file is a dependency manifest
# (package.json, package-lock.json, yarn.lock, npm-shrinkwrap.json) or the
# dependency-allowlist security script. Used to gate npm audit and the dep
# allowlist check in security-review.yml.
#
# ai_code_touched=true — at least one changed file is in the AI source surface
# (src/game/ai/**) or the AI prompt-injection validator
# (scripts/agent/security/check-ai-prompts.ts). Used to gate the AI prompt-
# injection check in security-review.yml.
#
# codeowners_touched=true — at least one changed file is the CODEOWNERS file,
# a workflow file (.github/workflows/**), or the CODEOWNERS validator
# (scripts/agent/security/check-codeowners.ts). Used to gate CODEOWNERS coverage
# validation in security-review.yml.
#
# source_code_touched=true — at least one changed file is in the production source
# surface scanned by check-dynamic-patterns.sh (src/core, src/engine, src/game,
# src/shared — excluding the data-only sprite-catalog.json) or is the dynamic-
# execution validator itself. Fail-safe: unknown/unclassified paths set
# source_code_touched=true so the dynamic-execution check always runs on ambiguous
# scope. Used to gate the dynamic-execution patterns scan in security-review.yml.
#
# Output: writes all flags to $GITHUB_OUTPUT (when set) and stdout.
# Test hook: SCOPE_FILES_OVERRIDE (newline-separated paths) classifies that list
# directly instead of deriving it from git — used by the deterministic unit test.
# Fail-safe: any ambiguity (no base, no changed files, detached history) yields
# false for scope-narrowing flags (art_only, docs_only, gameplay_safe,
# sprites_only), TRUE for sprite/sim/coverage flags (sprites_touched,
# sim_touched, coverage_touched, sprite_pipeline_touched), and TRUE for
# security-impact flags (dependencies_touched, ai_code_touched,
# codeowners_touched, source_code_touched) so that all gated checks always
# run on ambiguous scope. This script never blocks CI.

set -euo pipefail

emit_output() {
  local name="$1" value="$2"
  echo "${name}=${value}"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "${name}=${value}" >>"$GITHUB_OUTPUT"
  fi
}

# Emit all scope flags at once (fail-safe path uses this for early exits).
# Args: art_only docs_only gameplay_safe sprites_only sprites_touched
#       sim_touched coverage_touched sprite_pipeline_touched dependencies_touched
#       ai_code_touched codeowners_touched source_code_touched
emit_all() {
  emit_output art_only "$1"
  emit_output docs_only "$2"
  emit_output gameplay_safe "$3"
  emit_output sprites_only "$4"
  emit_output sprites_touched "$5"
  emit_output sim_touched "$6"
  emit_output coverage_touched "$7"
  emit_output sprite_pipeline_touched "$8"
  emit_output dependencies_touched "$9"
  emit_output ai_code_touched "${10}"
  emit_output codeowners_touched "${11}"
  emit_output source_code_touched "${12}"
}

# Emit visual surface flags (new in #1688/#1698).
# Called separately so the fail-safe paths can emit all-false without touching
# the original emit_all signature.
#   visual_touched      — any path that can affect browser rendering was changed
#   game_visual_touched — game/engine/UI visual surface (src/*, public/*, tests/e2e/* except devtools)
#   asset_visual_touched — generated art and sprite-catalog only
#   devtool_visual_touched — devtools browser UI and its e2e test
emit_visual_all() {
  emit_output visual_touched "$1"
  emit_output game_visual_touched "$2"
  emit_output asset_visual_touched "$3"
  emit_output devtool_visual_touched "$4"
}

# package.json gameplay-safe split:
# - safe when ONLY scripts changed and every changed script key is lab/devtools/sprites-facing
# - unsafe for dependency changes, non-script top-level keys, or unknown script keys
package_json_gameplay_safe() {
  if [ "${PACKAGE_JSON_GAMEPLAY_SAFE_OVERRIDE:-}" = "true" ]; then
    return 0
  fi
  if [ "${PACKAGE_JSON_GAMEPLAY_SAFE_OVERRIDE:-}" = "false" ]; then
    return 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    return 1
  fi
  if [ -z "${base_ref:-}" ]; then
    return 1
  fi
  if ! git cat-file -e "${base_ref}:package.json" 2>/dev/null; then
    return 1
  fi

  local base_pkg head_pkg
  base_pkg="$(git show "${base_ref}:package.json" 2>/dev/null || true)"
  head_pkg="$(cat package.json 2>/dev/null || true)"
  if [ -z "$base_pkg" ] || [ -z "$head_pkg" ]; then
    return 1
  fi

  BASE_PKG="$base_pkg" HEAD_PKG="$head_pkg" node -e '
const base = JSON.parse(process.env.BASE_PKG ?? "{}");
const head = JSON.parse(process.env.HEAD_PKG ?? "{}");

const depKeys = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
for (const key of depKeys) {
  if (JSON.stringify(base[key] ?? {}) !== JSON.stringify(head[key] ?? {})) {
    process.exit(1);
  }
}

const top = new Set([...Object.keys(base), ...Object.keys(head)]);
const changedTop = [...top].filter((key) => JSON.stringify(base[key]) !== JSON.stringify(head[key]));
if (changedTop.length === 0) process.exit(1);
if (changedTop.some((key) => key !== "scripts")) process.exit(1);

const baseScripts = base.scripts ?? {};
const headScripts = head.scripts ?? {};
const scriptKeys = new Set([...Object.keys(baseScripts), ...Object.keys(headScripts)]);
const changedScripts = [...scriptKeys].filter(
  (key) => JSON.stringify(baseScripts[key]) !== JSON.stringify(headScripts[key]),
);
if (changedScripts.length === 0) process.exit(1);

const safeScriptKey = /^(sprites:|lab$|devtools$|setup:azure(?::|$))/;
if (changedScripts.every((key) => safeScriptKey.test(key))) process.exit(0);
process.exit(1);
' >/dev/null 2>&1
}

# Resolve the set of changed files. Normally derived from git; the
# SCOPE_FILES_OVERRIDE test hook (newline-separated paths) lets the deterministic
# unit test drive the classifier without constructing a git scenario. Presence is
# detected with ${VAR+x}, NOT -n, so an explicitly empty override is honored as an
# empty change set (→ fail-safe all-false below) rather than silently falling back
# to git-based diffing.
base_ref=""
if [ -n "${SCOPE_FILES_OVERRIDE+x}" ]; then
  changed="${SCOPE_FILES_OVERRIDE:-}"
  # local-scope.sh passes changed files via override; keep a merge-base for optional
  # content-aware checks (for example package.json classification).
  base_ref="$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null || true)"
  echo "Using SCOPE_FILES_OVERRIDE (test hook)." >&2
else
  # Resolve the comparison base.
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
    emit_all false false false false true true true true true true true true
    # No diff available: fail toward broader validation — run all visual suites.
    emit_visual_all true true true true
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
# For legacy flags (art_only/docs_only/gameplay_safe/sprites_*): false triggers the
# broader gates (gameplay_safe=false → headless runs; art_only=false → full unit suite).
# For visual surface flags: we CANNOT safely skip — an empty/unknown diff means we
# don't know what changed, so all three visual suites must run (fail toward more).
if [ -z "$(printf '%s' "$changed" | tr -d '[:space:]')" ]; then
  emit_all false false false false true true true true true true true true
  emit_visual_all true true true true
  exit 0
fi

# art_only: every changed file is under the approved-art surface.
art_only=true
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    public/assets/generated/*) ;;
    src/shared/data/sprite-catalog.json) ;;
    briefs/*) ;;
    docs/*) ;;
    *)
      art_only=false
      break
      ;;
  esac
done <<<"$changed"

# docs_only: every changed file is under the documentation/governance surface or
# is a markdown/plain-text file outside src/. src/** is never docs (game logic
# can live there), so we break immediately if a src/ path appears.
docs_only=true
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    src/*) docs_only=false; break ;;
    docs/*) ;;
    .specify/specs/*) ;;
    AGENTS.md) ;;
    *.md) ;;
    *.txt) ;;
    *) docs_only=false; break ;;
  esac
done <<<"$changed"

# gameplay_safe: every changed file is provably unable to change the deterministic
# Floor-1 simulation. Allowlist = surfaces the headless runner never imports
# (src/engine, src/labs, src/devtools), plus e2e tests, docs, static assets,
# CI/workflow config, sprite-pipeline scripts/tests, and sprite catalog plumbing.
# Anything else — src/core, src/game, most src/shared, tests/headless — forces
# the gate to run.
# Consumed by ci.yml to skip the headless job on pull_requests only.
# The sprite pipeline (scripts/sprites/, tests/unit/sprites/, tests/integration/sprites/,
# and the 8 root pipeline integration tests) is also safe: the headless runner imports
# only src/core, src/shared, src/game/ai and never touches scripts/sprites/.
# .github/** (workflows, actions, extensions, instructions) is safe: CI/workflow YAML
# cannot affect the deterministic ECS sim the headless runner executes.
# src/devtools/** is safe: browser-only devtools UI code; the headless runner never
# imports it (layer rule: src/game/ai → never src/devtools).
gameplay_safe=true
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    src/engine/*) ;;
    src/labs/*) ;;
    src/devtools/*) ;;
    src/devtools-main.ts) ;;
    devtools.html) ;;
    tests/e2e/*) ;;
    docs/*) ;;
    public/*) ;;
    briefs/*) ;;
    .github/*) ;;
    src/shared/data/sprite-catalog.json) ;;
    package.json)
      if package_json_gameplay_safe; then
        :
      else
        gameplay_safe=false
        break
      fi
      ;;
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

# sim_touched: at least one changed file is in the simulation-critical surface.
# Fail-closed: unknown/unclassified paths set sim_touched=true (run the gate).
# ci.yml uses this to gate the headless Floor-1 job on PRs: headless runs only
# when sim_touched=true; main-push and schedule always run it as a backstop.
sim_touched=false
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    # Known surfaces that provably cannot affect the ECS sim.
    # NOTE: src/engine/* and src/labs/* are NOT listed here — headless tests
    # directly import engine modules (e.g. src/engine/lighting/light-field) and
    # lab scenario presets (e.g. src/labs/ai-runner-lab/scenario-presets), so
    # changes to those paths can alter headless test outcomes.
    tests/e2e/*) ;;
    tests/unit/*) ;;
    tests/integration/*) ;;
    docs/*) ;;
    public/*) ;;
    .github/*) ;;
    .specify/*) ;;
    scripts/*) ;;
    src/shared/data/sprite-catalog.json) ;;
    package.json)
      if package_json_gameplay_safe; then
        :
      else
        sim_touched=true
        break
      fi
      ;;
    *.md) ;;
    *.txt) ;;
    # Everything else (src/core, src/game, src/shared, src/bootstrap,
    # src/engine, src/labs, tests/headless, unknown paths) → simulation is
    # potentially touched.
    *)
      sim_touched=true
      break
      ;;
  esac
done <<<"$changed"

# coverage_touched: at least one changed file is in the unit-test coverage surface.
# Fail-closed: unknown/unclassified paths set coverage_touched=true (run the gate).
# ci.yml uses this to gate the advisory unit-coverage job on PRs:
# coverage runs only when coverage_touched=true; main-push and schedule always run it.
coverage_touched=false
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    # Known surfaces that provably cannot affect unit test coverage.
    # NOTE: src/engine/* is NOT listed here — vitest includes src/**/*.ts for
    # coverage (only specific engine files are excluded), and many unit tests
    # directly import engine modules, so engine changes can alter coverage numbers.
    # src/labs/* IS safe here: vitest explicitly excludes src/labs/** from coverage.
    src/labs/*) ;;
    tests/e2e/*) ;;
    tests/headless/*) ;;
    tests/integration/*) ;;
    docs/*) ;;
    public/*) ;;
    .github/*) ;;
    .specify/*) ;;
    scripts/*) ;;
    src/shared/data/sprite-catalog.json) ;;
    package.json)
      if package_json_gameplay_safe; then
        :
      else
        coverage_touched=true
        break
      fi
      ;;
    *.md) ;;
    *.txt) ;;
    tests/unit/sprites/*) ;;
    # Everything else (src/core, src/game, src/shared, src/bootstrap,
    # src/engine, tests/unit non-sprites, unknown paths) → unit coverage is
    # potentially touched.
    *)
      coverage_touched=true
      break
      ;;
  esac
done <<<"$changed"

# sprite_pipeline_touched: alias for sprites_touched with a clearer name for
# downstream consumers. Always kept identical.
sprite_pipeline_touched="$sprites_touched"

# dependencies_touched: at least one changed file is a dependency manifest
# (package.json, package-lock.json, yarn.lock, npm-shrinkwrap.json), the
# dependency-allowlist security script, or the npm-audit wrapper (which hosts
# temporary audit exceptions). Consumed by security-review.yml to gate
# npm audit and the dep-allowlist check.
dependencies_touched=false
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    package.json | package-lock.json | yarn.lock | npm-shrinkwrap.json)
      dependencies_touched=true; break ;;
    scripts/agent/security/check-deps.ts)
      dependencies_touched=true; break ;;
    scripts/agent/security/npm-audit.mjs)
      dependencies_touched=true; break ;;
  esac
done <<<"$changed"

# ai_code_touched: at least one changed file is in the AI source surface or the
# AI prompt-injection validator. Consumed by security-review.yml to gate the
# AI prompt-injection scan. Note: .github/instructions/*.md are docs-only and
# check-ai-prompts.ts only scans src/game/ai, so they are intentionally excluded.
ai_code_touched=false
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    src/game/ai/*) ai_code_touched=true; break ;;
    scripts/agent/security/check-ai-prompts.ts) ai_code_touched=true; break ;;
  esac
done <<<"$changed"

# codeowners_touched: at least one changed file is the CODEOWNERS file, a workflow
# file (.github/workflows/**), or the CODEOWNERS validator. Consumed by
# security-review.yml to gate CODEOWNERS coverage validation.
codeowners_touched=false
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    CODEOWNERS | .github/CODEOWNERS) codeowners_touched=true; break ;;
    .github/workflows/*) codeowners_touched=true; break ;;
    scripts/agent/security/check-codeowners.ts) codeowners_touched=true; break ;;
  esac
done <<<"$changed"

# source_code_touched: at least one changed file is in the production source surface
# scanned by check-dynamic-patterns.sh (src/core, src/engine, src/game, src/shared
# — excluding the data-only sprite-catalog.json) or is the dynamic-execution
# validator itself. Fail-safe: unknown/unclassified paths set source_code_touched=true
# so the dynamic-execution check always runs on ambiguous scope.
source_code_touched=false
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    # Data-only: not code, safe to skip even though it's under src/shared.
    src/shared/data/sprite-catalog.json) ;;
    # Production source surfaces scanned by check-dynamic-patterns.sh.
    src/core/* | src/engine/* | src/game/* | src/shared/*)
      source_code_touched=true; break ;;
    # Dynamic-execution validator: changing it means the check definitions changed.
    scripts/agent/security/check-dynamic-patterns.sh)
      source_code_touched=true; break ;;
    # Non-source surfaces: safe to skip the dynamic-execution scan.
    src/labs/*) ;;
    src/devtools/*) ;;
    src/devtools-main.ts) ;;
    devtools.html) ;;
    tests/*) ;;
    docs/*) ;;
    public/*) ;;
    .github/*) ;;
    .specify/*) ;;
    scripts/*) ;;
    AGENTS.md) ;;
    CODEOWNERS | .github/CODEOWNERS) ;;
    package.json | package-lock.json | yarn.lock | npm-shrinkwrap.json) ;;
    *.md) ;;
    *.txt) ;;
    # Unknown path: fail toward running the check (conservative).
    *)
      source_code_touched=true; break ;;
  esac
done <<<"$changed"

# security_infra_upgrade: when the security workflow itself or the scope classifier
# that gates its steps is changed, all four security-impact flags are forced to
# true. This ensures a PR that edits security-review.yml or detect-art-only.sh
# actually exercises the npm audit, dependency-allowlist, AI prompt, CODEOWNERS,
# and dynamic-execution checks that the modified workflow controls.
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    .github/workflows/security-review.yml | scripts/agent/ci/detect-art-only.sh)
      dependencies_touched=true; ai_code_touched=true; codeowners_touched=true
      source_code_touched=true; break ;;
  esac
done <<<"$changed"

emit_all "$art_only" "$docs_only" "$gameplay_safe" "$sprites_only" "$sprites_touched" "$sim_touched" "$coverage_touched" "$sprite_pipeline_touched" "$dependencies_touched" "$ai_code_touched" "$codeowners_touched" "$source_code_touched"

# ── Visual surface flags (#1688/#1698) ────────────────────────────────────────
# Classify each changed file into one or more visual surfaces.
# Fail-safe: unknown paths set visual_touched=true and game_visual_touched=true
# so that the broader E2E suite runs and no visual assertion is silently dropped.
#
# Surface definitions:
#   asset_visual   — generated art + sprite catalog (art_only paths only)
#   devtool_visual — devtools browser UI (src/devtools/**) and its E2E test
#   game_visual    — all other src/*, public/*, and non-devtool tests/e2e/*
#   visual_touched — union: any of the three surfaces above was touched
#
# Non-visual (never contribute to visual_touched):
#   .github/**                   CI config / workflow / extensions / instructions
#   docs/**, .specify/**, *.md, *.txt, AGENTS.md   documentation
#   scripts/agent/**             CI/automation helper scripts
#   scripts/sprites/**           sprite GENERATION pipeline (not the generated output)
#   tests/unit/**, tests/ecs/**, tests/game/**, tests/property/**,
#   tests/determinism/**, tests/sensors/**, tests/balance/**,
#   tests/integration/**, tests/headless/**, tests/helpers/**,
#   tests/bench/**, tests/setup.ts   non-E2E tests (pure logic; no browser)
visual_touched=false
game_visual_touched=false
asset_visual_touched=false
devtool_visual_touched=false

while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    # ── Non-visual surfaces ──────────────────────────────────────────────────────
    .github/*) ;;
    docs/*) ;;
    .specify/*) ;;
    AGENTS.md) ;;
    *.md) ;;
    *.txt) ;;
    scripts/agent/*) ;;
    scripts/sprites/*) ;;
    tests/unit/*) ;;
    tests/ecs/*) ;;
    tests/game/*) ;;
    tests/property/*) ;;
    tests/determinism/*) ;;
    tests/sensors/*) ;;
    tests/balance/*) ;;
    tests/integration/*) ;;
    tests/headless/*) ;;
    tests/helpers/*) ;;
    tests/bench/*) ;;
    tests/setup.ts) ;;
    # ── Asset visual: generated art + sprite catalog ──────────────────────────────
    public/assets/generated/*)
      visual_touched=true; asset_visual_touched=true ;;
    src/shared/data/sprite-catalog.json)
      visual_touched=true; asset_visual_touched=true ;;
    # ── Devtools visual: devtools browser UI + its E2E test ──────────────────────
    src/devtools/*)
      visual_touched=true; devtool_visual_touched=true ;;
    src/devtools-main.ts)
      visual_touched=true; devtool_visual_touched=true ;;
    devtools.html)
      visual_touched=true; devtool_visual_touched=true ;;
    tests/e2e/sprite-workflow-sensors.test.ts)
      visual_touched=true; devtool_visual_touched=true ;;
    # ── Game visual: non-devtool E2E tests ───────────────────────────────────────
    # Shared E2E setup/constants/helpers are consumed by ALL three projects, so a
    # change there must trigger every surface (fail toward broader validation).
    tests/e2e/global-setup.ts | tests/e2e/e2e-constants.ts | tests/e2e/helpers/*)
      visual_touched=true; game_visual_touched=true; asset_visual_touched=true; devtool_visual_touched=true ;;
    tests/e2e/*)
      visual_touched=true; game_visual_touched=true ;;
    # ── Game visual: all other src/*, public/* (and root config files) ────────────
    # Note: root config files (tsconfig.json, package.json, etc.) that are not
    # explicitly allowlisted above fall through to game_visual here. This is
    # intentional: they are not provably non-visual, so we fail toward broader
    # validation (same fail-safe philosophy as the unknown catch-all below).
    src/* | public/*)
      visual_touched=true; game_visual_touched=true ;;
    # ── Unknown: fail toward broader validation ───────────────────────────────────
    # Any path not explicitly classified above enables ALL three visual suites.
    # An unknown file type may affect any visual surface, so we fail toward running
    # everything rather than silently skipping a potentially-affected surface.
    *)
      visual_touched=true; game_visual_touched=true; asset_visual_touched=true; devtool_visual_touched=true ;;
  esac
done <<<"$changed"

emit_visual_all "$visual_touched" "$game_visual_touched" "$asset_visual_touched" "$devtool_visual_touched"

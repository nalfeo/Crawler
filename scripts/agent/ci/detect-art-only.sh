#!/usr/bin/env bash
#
# detect-art-only.sh — detect change scope and emit classification flags.
#
# ── Legacy flags (unchanged — all existing consumers remain compatible) ────────
#
# art_only=true  — every changed file is under the approved-art surface:
#   - public/assets/generated/**        (sprites + manifest.json)
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
# ── Orthogonal impact flags (new — fail-closed, independent of each other) ────
#
# visual_touched=true  — at least one changed file is in the visual/rendering
#   surface (src/engine, src/labs, public/**, sprite-catalog.json). Unknown or
#   unclassified paths also set this to true (fail-closed).
#
# sim_touched=true     — at least one changed file is in the deterministic ECS
#   simulation layer (src/core, src/game, src/shared excluding art catalog,
#   tests/headless). Unknown or unclassified paths also set this to true.
#
# coverage_touched=true — at least one changed file could affect test-coverage
#   metrics (src/**, tests/** excluding sprite-pipeline and e2e). Unknown paths
#   also set this to true.
#
# sprite_pipeline_touched=true — equivalent to sprites_touched; at least one
#   sprite-pipeline file changed. Derived from sprites_touched for consistency.
#
# dependencies_touched=true — package.json dependency sections or package-lock.json
#   changed. Fail-closed when content analysis is unavailable.
#
# Neutral companion files: handoffs (docs/knowledge/handoffs/**), review ledgers
# (docs/knowledge/review-ledgers/**), and generated metadata (docs/**) fall under
# the docs surface and do NOT broaden visual_touched, sim_touched, or
# coverage_touched — their documentation/format validation is preserved via
# docs_only and the review-ledger guard.
#
# ── Common semantics ──────────────────────────────────────────────────────────
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
  emit_output visual_touched "$6"
  emit_output sim_touched "$7"
  emit_output coverage_touched "$8"
  emit_output sprite_pipeline_touched "$9"
  emit_output dependencies_touched "${10}"
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

# package.json dep-change detection:
# Returns 0 (true) if any dependency section in package.json changed vs base.
# Returns 1 (false) if no dep section changed (e.g. scripts-only).
# Returns 2 (unknown) if cannot determine (no node, no base_ref, parse error).
# Test hook: PACKAGE_JSON_DEPS_TOUCHED_OVERRIDE=true/false/unknown
package_json_deps_changed() {
  if [ "${PACKAGE_JSON_DEPS_TOUCHED_OVERRIDE:-}" = "true" ]; then
    return 0
  fi
  if [ "${PACKAGE_JSON_DEPS_TOUCHED_OVERRIDE:-}" = "false" ]; then
    return 1
  fi
  if [ "${PACKAGE_JSON_DEPS_TOUCHED_OVERRIDE:-}" = "unknown" ]; then
    return 2
  fi
  if ! command -v node >/dev/null 2>&1; then
    return 2
  fi
  if [ -z "${base_ref:-}" ]; then
    return 2
  fi
  if ! git cat-file -e "${base_ref}:package.json" 2>/dev/null; then
    return 2
  fi
  local base_pkg head_pkg
  base_pkg="$(git show "${base_ref}:package.json" 2>/dev/null || true)"
  head_pkg="$(cat package.json 2>/dev/null || true)"
  if [ -z "$base_pkg" ] || [ -z "$head_pkg" ]; then
    return 2
  fi
  BASE_PKG="$base_pkg" HEAD_PKG="$head_pkg" node -e '
const base = JSON.parse(process.env.BASE_PKG ?? "{}");
const head = JSON.parse(process.env.HEAD_PKG ?? "{}");
const depKeys = ["dependencies","devDependencies","peerDependencies","optionalDependencies"];
for (const key of depKeys) {
  if (JSON.stringify(base[key] ?? {}) !== JSON.stringify(head[key] ?? {})) {
    process.exit(0);
  }
}
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
    emit_all false false false false false false false false false false
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
  emit_all false false false false false false false false false false
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
# (src/engine, src/labs), plus e2e tests, docs, static assets, CI/workflow config,
# sprite-pipeline scripts/tests, and sprite catalog plumbing. Anything else —
# src/core, src/game, most src/shared, tests/headless — forces the gate to run.
# Consumed by ci.yml to skip the headless job on pull_requests only.
# The sprite pipeline (scripts/sprites/, tests/unit/sprites/, tests/integration/sprites/,
# and the 8 root pipeline integration tests) is also safe: the headless runner imports
# only src/core, src/shared, src/game/ai and never touches scripts/sprites/.
# .github/** (workflows, actions, extensions, instructions) is safe: CI/workflow YAML
# cannot affect the deterministic ECS sim the headless runner executes.
gameplay_safe=true
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    src/engine/*) ;;
    src/labs/*) ;;
    tests/e2e/*) ;;
    docs/*) ;;
    public/*) ;;
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

# ── Orthogonal impact flags ───────────────────────────────────────────────────

# visual_touched: at least one changed file is in the visual/rendering surface
# (src/engine, src/labs, public/**, sprite-catalog). Unknown paths fail closed.
visual_touched=false
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    # Positive: rendering/visual/art surfaces
    src/engine/*) visual_touched=true; break ;;
    src/labs/*) visual_touched=true; break ;;
    public/*) visual_touched=true; break ;;
    # sprite-catalog before the broad src/shared/* neutral to ensure first-match
    src/shared/data/sprite-catalog.json) visual_touched=true; break ;;
    # Neutral: simulation, tests, docs, CI/tooling
    src/core/*) ;;
    src/game/*) ;;
    src/shared/*) ;;
    tests/*) ;;
    docs/*) ;;
    .specify/specs/*) ;;
    AGENTS.md) ;;
    *.md) ;;
    *.txt) ;;
    .github/*) ;;
    scripts/*) ;;
    package.json)
      if package_json_gameplay_safe; then
        :
      else
        visual_touched=true; break
      fi
      ;;
    # Unknown path → fail closed
    *) visual_touched=true; break ;;
  esac
done <<<"$changed"

# sim_touched: at least one changed file is in the deterministic ECS simulation
# layer. src/core, src/game, src/shared (non-art catalog), and headless tests
# feed the simulation. Unknown paths fail closed.
sim_touched=false
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    # Positive: simulation layer
    src/core/*) sim_touched=true; break ;;
    src/game/*) sim_touched=true; break ;;
    tests/headless/*) sim_touched=true; break ;;
    # src/shared: sprite-catalog is art-only; all other shared code feeds the sim.
    # Specific path must precede the broad src/shared/* case.
    src/shared/data/sprite-catalog.json) ;;
    src/shared/*) sim_touched=true; break ;;
    # Neutral: rendering-only, sprite pipeline, docs, tests that don't affect sim
    src/engine/*) ;;
    src/labs/*) ;;
    public/*) ;;
    # Sprite-specific test paths before the broad tests/* neutral
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
    tests/*) ;;
    docs/*) ;;
    .specify/specs/*) ;;
    AGENTS.md) ;;
    *.md) ;;
    *.txt) ;;
    .github/*) ;;
    scripts/*) ;;
    package.json)
      if package_json_gameplay_safe; then
        :
      else
        sim_touched=true; break
      fi
      ;;
    # Unknown path → fail closed
    *) sim_touched=true; break ;;
  esac
done <<<"$changed"

# coverage_touched: at least one changed file could affect unit/integration test
# coverage metrics. All src/** (coverage source) and non-sprite, non-e2e tests
# count. Unknown paths fail closed.
coverage_touched=false
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    # Positive: all source code (coverage config instruments src/**/*.ts)
    src/*) coverage_touched=true; break ;;
    # Positive: headless tests affect the headless coverage project
    tests/headless/*) coverage_touched=true; break ;;
    # Sprite pipeline tests are in their own project → neutral for game coverage
    # These must precede the broad tests/* positive case.
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
    # E2E tests run under Playwright, not the unit/integration coverage instrument
    tests/e2e/*) ;;
    # All other tests (unit, integration, ecs, game, etc.) → positive
    tests/*) coverage_touched=true; break ;;
    # Neutral: docs, public assets, CI/tooling
    docs/*) ;;
    .specify/specs/*) ;;
    AGENTS.md) ;;
    *.md) ;;
    *.txt) ;;
    .github/*) ;;
    scripts/*) ;;
    public/*) ;;
    package.json)
      if package_json_gameplay_safe; then
        :
      else
        coverage_touched=true; break
      fi
      ;;
    # Unknown path → fail closed
    *) coverage_touched=true; break ;;
  esac
done <<<"$changed"

# sprite_pipeline_touched: derived directly from sprites_touched to avoid
# duplicating the allowlist. Same positive set; emitted as a separate output so
# future consumers can migrate to the orthogonal flag without a rename.
sprite_pipeline_touched="$sprites_touched"

# dependencies_touched: package.json dependency sections or package-lock.json
# changed. Fail-closed when content analysis is unavailable (no node, no base,
# or the dep-vs-scripts distinction cannot be made).
dependencies_touched=false
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    package-lock.json) dependencies_touched=true; break ;;
    package.json)
      # Tri-state: 0=deps changed, 1=no dep change, 2=unknown
      pkg_deps_rc=0
      package_json_deps_changed || pkg_deps_rc=$?
      if [ "$pkg_deps_rc" -eq 0 ] || [ "$pkg_deps_rc" -eq 2 ]; then
        # deps definitely changed OR cannot determine → fail closed
        dependencies_touched=true; break
      fi
      # pkg_deps_rc=1: no dep change (scripts-only or other non-dep change)
      ;;
  esac
done <<<"$changed"

emit_all "$art_only" "$docs_only" "$gameplay_safe" "$sprites_only" "$sprites_touched" \
  "$visual_touched" "$sim_touched" "$coverage_touched" "$sprite_pipeline_touched" "$dependencies_touched"

#!/usr/bin/env bash
set -euo pipefail

echo "🔧 Preflight: Installing dependencies..."
# Skip the (destructive, ~node_modules-wiping) `npm ci` when the installed
# node_modules already corresponds exactly to the current package-lock.json.
# We record the lockfile's content hash in a sentinel under node_modules after a
# successful install; `npm ci` wipes node_modules (and the sentinel) on every
# real run, so a present + matching sentinel proves a prior install completed
# for this exact lockfile. This mirrors the repo's CI node_modules cache, which
# is likewise keyed on hashFiles('package-lock.json') (.github/actions/setup-node).
LOCK_HASH_FILE="node_modules/.preflight-lock-hash"
compute_lock_hash() {
  if command -v git >/dev/null 2>&1; then
    git hash-object package-lock.json 2>/dev/null && return 0
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum package-lock.json | cut -d' ' -f1 && return 0
  fi
  echo ""
}
lock_hash="$(compute_lock_hash)"
if [ -n "$lock_hash" ] && [ -d node_modules ] && [ -f "$LOCK_HASH_FILE" ] \
  && [ "$(cat "$LOCK_HASH_FILE" 2>/dev/null)" = "$lock_hash" ]; then
  echo "   ✓ node_modules already matches package-lock.json — skipping npm ci."
else
  npm ci --prefer-offline --silent
  [ -n "$lock_hash" ] && printf '%s' "$lock_hash" > "$LOCK_HASH_FILE"
fi

echo "🌐 Preflight: Installing Playwright Chromium browser..."
npx playwright install chromium

echo "🔍 Preflight: Type checking..."
npx tsc --noEmit

echo "🧠 Preflight: Seeding agent memory graph..."
# Creates and one-time-seeds the per-user live memory graph from the committed
# snapshot so the MCP memory server has facts on first launch. Never overwrites
# an existing live file. Non-fatal: memory is an enhancement, not a gate.
node scripts/agent/mcp-memory-server.mjs --ensure || echo "⚠️  Memory seed skipped (non-fatal)"

# Non-blocking persona-routing hint. Informational only — never fails the
# preflight, never calls an LLM (keeps CI deterministic per the constitution).
# Suggests a persona from changed paths if a diff vs main exists; otherwise just
# points at the routing matrix.
persona_hint() {
  echo "🎭 Preflight: Persona routing hint"
  echo "   Select your persona from docs/agent-os/personas/README.md"
  echo "   (default to Producer for multi-layer or ambiguous tasks)."

  local base changed
  base="$(git merge-base HEAD origin/main 2>/dev/null || true)"
  [ -z "$base" ] && return 0
  changed="$(git diff --name-only "$base" 2>/dev/null || true)"
  [ -z "$changed" ] && return 0

  declare -A suggested=()
  while IFS= read -r f; do
    case "$f" in
      src/core/*) suggested["Systems Engineer"]=1 ;;
      src/shared/data/quests.*|src/game/floor*Scenario*) suggested["Content Designer"]=1 ;;
      src/game/*) suggested["Game Designer"]=1 ;;
      src/labs/*) suggested["Game Designer"]=1 ;;
      briefs/*|data/palettes/*|src/engine/sprites/*) suggested["Graphics Designer"]=1 ;;
      src/engine/*) suggested["UX Designer"]=1 ;;
      tests/*) suggested["QA Engineer"]=1 ;;
      .github/workflows/*|scripts/agent/*) suggested["DevOps Engineer"]=1 ;;
    esac
  done <<< "$changed"

  if [ "${#suggested[@]}" -gt 0 ]; then
    echo "   Changed paths suggest: ${!suggested[*]}"
    [ "${#suggested[@]}" -gt 1 ] && echo "   Multiple layers touched — consider adopting Producer to coordinate."
  fi
  return 0
}
persona_hint || true

echo "✅ Preflight complete. Environment is ready."

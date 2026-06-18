#!/usr/bin/env bash
set -euo pipefail

echo "🔧 Preflight: Installing dependencies..."
npm ci --prefer-offline --silent

echo "🔍 Preflight: Type checking..."
npx tsc --noEmit

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

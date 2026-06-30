#!/usr/bin/env bash
#
# detect-art-only.sh — detect change scope and emit art_only + docs_only flags.
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
# Output: writes both flags to $GITHUB_OUTPUT (when set) and stdout.
# Fail-safe: any ambiguity (no base, no changed files, detached history) yields
# false for both flags, so the full suite runs. This script never blocks CI.

set -euo pipefail

emit_output() {
  local name="$1" value="$2"
  echo "${name}=${value}"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "${name}=${value}" >>"$GITHUB_OUTPUT"
  fi
}

# Emit both flags at once (fail-safe path uses this for early exits).
emit_all() {
  emit_output art_only "$1"
  emit_output docs_only "$2"
}

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
  emit_all false false
  exit 0
fi

changed="$(git diff --name-only "${base_ref}...HEAD" 2>/dev/null || true)"
if [ -z "$changed" ]; then
  # Two-dot fallback for non-merge-base histories (e.g. force-push).
  changed="$(git diff --name-only "${base_ref}" HEAD 2>/dev/null || true)"
fi

echo "Comparison base: ${base_ref}" >&2
echo "Changed files:" >&2
echo "${changed:-<none>}" >&2

if [ -z "$changed" ]; then
  emit_all false false
  exit 0
fi

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

emit_output art_only "$art_only"

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

emit_output docs_only "$docs_only"

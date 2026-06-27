#!/usr/bin/env bash
#
# detect-art-only.sh — decide whether a change set touches ONLY generated art.
#
# "Art-only" means every changed file is under the approved-art surface:
#   - public/assets/generated/**        (sprites + manifest.json)
#   - src/shared/data/sprite-catalog.json
#
# When a push/PR is art-only, CI can safely skip the heavy gameplay gates
# (integration, headless, e2e, build) and keep only typecheck/lint/format/unit.
# Adding a checked-in PNG cannot change game logic, so those gates would only
# burn minutes. The merge-gate treats the skipped heavy jobs as PASS in this
# case (see ci.yml).
#
# Output: writes `art_only=true|false` to $GITHUB_OUTPUT (when set) and stdout.
# Fail-safe: any ambiguity (no base, no changed files, detached history) yields
# `false`, so the full suite runs. This script never blocks CI on its own.

set -euo pipefail

emit() {
  local value="$1"
  echo "art_only=${value}"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "art_only=${value}" >>"$GITHUB_OUTPUT"
  fi
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
  emit false
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
  emit false
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

emit "$art_only"

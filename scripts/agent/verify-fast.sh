#!/usr/bin/env bash
set -euo pipefail

run_with_timeout() {
  local timeout_seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "${timeout_seconds}s" "$@"
    return $?
  fi
  # Fallback for environments without GNU coreutils timeout.
  perl -e '
    my $timeout = shift @ARGV;
    local $SIG{ALRM} = sub { exit 124 };
    alarm $timeout;
    exec @ARGV;
  ' "$timeout_seconds" "$@"
}

echo "🔍 Step 1-2/3: Type checking + Linting (parallel)..."

# Decide ESLint scope. CI lints the whole tree (authoritative gate). Locally we
# lint only the files that changed vs the branch base + the working tree. This
# is safe: the ESLint config here has NO type-aware or cross-file rules
# (typescript-eslint "recommended" + per-file no-restricted-imports), and CI
# re-lints everything on the PR. It matters a lot — ESLint hashes all ~465 files
# for its cache even when nothing changed (~22s of pure overhead), whereas a
# typical change set is a handful of files (~3-5s), making this the biggest win
# on the most frequently run command.
LINT_CMD=(npx eslint src/ tests/ scripts/ --cache --cache-location .cache/eslint/.eslintcache --max-warnings 0)
if [ -z "${CI:-}" ] && command -v git >/dev/null 2>&1; then
  base="$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null || true)"
  changed_ts=()
  while IFS= read -r f; do
    # Skip blanks and any path that no longer exists on disk. A file deleted or
    # renamed-away in this branch still shows up in the diff, but ESLint errors
    # when handed a path that isn't there — which would break the most
    # frequently-run command for the life of the branch.
    [ -n "$f" ] && [ -f "$f" ] && changed_ts+=("$f")
  done < <(
    {
      # --diff-filter=ACMR drops deletions (D) and reports renames at their new
      # path, so vanished paths never reach the existence check above.
      [ -n "$base" ] && git diff --name-only --diff-filter=ACMR "$base"
      git diff --name-only --diff-filter=ACMR
      git diff --name-only --diff-filter=ACMR --cached
      git ls-files --others --exclude-standard
    } 2>/dev/null | grep -E '^(src|tests|scripts)/.*\.ts$' | sort -u
  )
  if [ "${#changed_ts[@]}" -eq 0 ]; then
    echo "   ✓ No changed TS files to lint (full tree is re-linted in CI)."
    LINT_CMD=(true)
  else
    echo "   Linting ${#changed_ts[@]} changed file(s) (full tree is re-linted in CI)..."
    LINT_CMD=(npx eslint "${changed_ts[@]}" --cache --cache-location .cache/eslint/.eslintcache --max-warnings 0)
  fi
fi

npx tsc --noEmit --project tsconfig.src.json &
TSC_PID=$!
"${LINT_CMD[@]}" &
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

echo "🔍 Step 3/3: Unit tests..."
if [ -n "${CI:-}" ]; then
  npx vitest run --project unit --reporter=dot
else
  npx vitest run --changed --project unit --reporter=dot --passWithNoTests
fi

echo "✅ Fast verification passed."

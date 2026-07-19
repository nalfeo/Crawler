#!/usr/bin/env bash
set -euo pipefail
# Enable monitor mode: every background (&) job runs in its own process group.
# This lets cleanup_parallel send SIGTERM to the entire group (e.g. npx + its
# spawned node/tsc/eslint children) rather than just the top-level PID.
set -m

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

echo "🔍 Step 1/3: Full-project type checking + linting (parallel)..."

# The production verifier always uses the authoritative project, which includes
# vite.config.ts plus src/**/*.ts, tests/**/*.ts, scripts/**/*.ts, and
# tools/**/*.ts.
# TypeScript's existing incremental metadata keeps repeat runs fast without
# changing compiler context.
TSC_PROJECT="tsconfig.json"
test_static_only=0
if [ "${NODE_ENV:-}" = "test" ] && [ "${VERIFY_FAST_TEST_STATIC_ONLY:-}" = "1" ]; then
  # Regression tests exercise this real parallel gate against isolated projects
  # and stop before the unrelated unit/headless phases.
  test_static_only=1
  TSC_PROJECT="${VERIFY_FAST_TSC_PROJECT:-$TSC_PROJECT}"
fi

is_supported_ts_path() {
  case "$1" in
    vite.config.ts | src/*.ts | tests/*.ts | scripts/*.ts | tools/*.ts) return 0 ;;
    *) return 1 ;;
  esac
}

# Decide ESLint scope. CI lints the whole tree (authoritative gate). Locally we
# lint only the files that changed vs the branch base + the working tree. This
# is safe: the ESLint config here has NO type-aware or cross-file rules
# (typescript-eslint "recommended" + per-file no-restricted-imports), and CI
# re-lints everything on the PR. It matters a lot — ESLint hashes all ~465 files
# for its cache even when nothing changed (~22s of pure overhead), whereas a
# typical change set is a handful of files (~3-5s), making this the biggest win
# on the most frequently run command.
LINT_CMD=(npx eslint vite.config.ts src/ tests/ scripts/ tools/ --cache --cache-location .cache/eslint/.eslintcache --max-warnings 0)
if command -v git >/dev/null 2>&1; then
  base="$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null || true)"
  changed_repo_ts=()
  changed_ts=()
  unsupported_ts=()
  while IFS= read -r f; do
    # Skip blanks and any path that no longer exists on disk. A file deleted or
    # renamed-away in this branch still shows up in the diff, but ESLint errors
    # when handed a path that isn't there — which would break the most
    # frequently-run command for the life of the branch.
    [ -n "$f" ] && [ -f "$f" ] && changed_repo_ts+=("$f")
  done < <(
    {
      # --diff-filter=ACMR drops deletions (D) and reports renames at their new
      # path, so vanished paths never reach the existence check above.
      [ -n "$base" ] && git diff --name-only --diff-filter=ACMR "$base"
      git diff --name-only --diff-filter=ACMR
      git diff --name-only --diff-filter=ACMR --cached
      git ls-files --others --exclude-standard
    } 2>/dev/null | grep -E '\.ts$' | sort -u
  )
  for f in "${changed_repo_ts[@]}"; do
    if is_supported_ts_path "$f"; then
      changed_ts+=("$f")
    else
      unsupported_ts+=("$f")
    fi
  done
  if [ "${#unsupported_ts[@]}" -ne 0 ]; then
    echo "❌ verify:fast does not support changed TypeScript files outside vite.config.ts, src/, tests/, scripts/, and tools/:" >&2
    printf '   - %s\n' "${unsupported_ts[@]}" >&2
    echo "   Move the file into a supported tree or extend verify:fast + tsconfig.json first." >&2
    exit 1
  fi
  if [ "$test_static_only" -eq 1 ]; then
    LINT_CMD=(true)
  elif [ -z "${CI:-}" ]; then
    if [ "${#changed_ts[@]}" -eq 0 ]; then
      echo "   ✓ No changed TS files to lint (full tree is re-linted in CI)."
      LINT_CMD=(true)
    else
      echo "   Linting ${#changed_ts[@]} changed file(s) (full tree is re-linted in CI)..."
      LINT_CMD=(npx eslint "${changed_ts[@]}" --cache --cache-location .cache/eslint/.eslintcache --max-warnings 0)
    fi
  fi
elif [ "$test_static_only" -eq 1 ]; then
  LINT_CMD=(true)
fi

# In test_static_only mode, allow long-running stubs so signal-lifecycle tests
# can send SIGTERM and assert exit-143 behaviour without real compiler invocations.
tsc_cmd=(npx tsc --noEmit --project "$TSC_PROJECT")
if [ "$test_static_only" -eq 1 ] && [ -n "${VERIFY_FAST_TSC_STUB_SECONDS:-}" ]; then
  stub_secs="${VERIFY_FAST_TSC_STUB_SECONDS//[^0-9]/}"
  # Cap at 600 s to avoid runaway processes from an accidental large value.
  if [ -n "$stub_secs" ] && [ "$stub_secs" -gt 600 ]; then stub_secs=600; fi
  if [ "${VERIFY_FAST_TSC_STUB_WITH_DESCENDANT:-0}" = "1" ]; then
    # Optional test hook: each stub job launches a long-lived child process so
    # signal-lifecycle tests can assert process-group cleanup kills descendants.
    tsc_cmd=(bash -c 'sleep "$1" & child=$!; [ -n "$2" ] && printf "%s\n" "$child" > "$2"; wait "$child"' _ "${stub_secs:-1}" "${VERIFY_FAST_TSC_STUB_TSC_CHILD_PID_FILE:-}")
    LINT_CMD=(bash -c 'sleep "$1" & child=$!; [ -n "$2" ] && printf "%s\n" "$child" > "$2"; wait "$child"' _ "${stub_secs:-1}" "${VERIFY_FAST_TSC_STUB_ESLINT_CHILD_PID_FILE:-}")
  else
    tsc_cmd=(sleep "${stub_secs:-1}")
    LINT_CMD=(sleep "${stub_secs:-1}")
  fi
fi

"${tsc_cmd[@]}" &
TSC_PID=$!
"${LINT_CMD[@]}" &
ESLINT_PID=$!

cleanup_parallel() {
  # Kill the entire process group for each job (negative PID) so child processes
  # (e.g. npx → node → tsc/eslint) cannot outlive their launcher.
  # Works because set -m gives every background job its own process group whose
  # PGID equals the job leader's PID.
  kill -- -"$TSC_PID" -"$ESLINT_PID" 2>/dev/null || true
  # No blocking wait in the EXIT trap — the shell exits immediately after and
  # the OS reaps any remaining children.
}
trap cleanup_parallel EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

tsc_status=0
eslint_status=0
wait "$TSC_PID" || tsc_status=$?
wait "$ESLINT_PID" || eslint_status=$?
trap - EXIT INT TERM

if [ "$tsc_status" -ne 0 ]; then
  exit "$tsc_status"
fi

if [ "$eslint_status" -ne 0 ]; then
  exit "$eslint_status"
fi

if [ "$test_static_only" -eq 1 ]; then
  echo "✅ Fast verifier static checks passed."
  exit 0
fi

echo "🔍 Step 2/3: Changed tests..."
if [ -n "${CI:-}" ]; then
  npx vitest run --project unit --reporter=dot
  npx vitest run --project sprites --reporter=dot
else
  npx vitest run --changed --project unit --reporter=dot --passWithNoTests
  # Also run changed sprite pipeline tests (scripts/sprites/** maps to tests/unit/sprites/**
  # and tests/integration/sprites/**). The --changed filter handles the case where no
  # sprite files changed (passWithNoTests suppresses the "no tests found" error).
  npx vitest run --changed --project sprites --reporter=dot --passWithNoTests
fi

echo "🔍 Step 3/3: Physics-defs sync + Size + Weight coverage checks..."
# physics-defs-sync is cheap and checks data drift (a docs-only entity-sizing.md
# edit is gameplay_safe yet must still be validated against the code), so it always
# runs.
npx tsx scripts/agent/health/check-physics-defs-sync.ts

# size + weight coverage each replay an 800-frame headless Floor-1 sim. That sim
# imports only src/core, src/shared and src/game/ai, so a change set classified
# gameplay_safe (the same allowlist ci.yml uses to skip the 306s headless gate)
# provably cannot alter it — the checks would recompute an identical result. Skip
# them locally in that case to keep the most frequently-run command fast.
#
# IMPORTANT: these two checks are LOCAL-ONLY (not wired into any CI workflow — a
# pre-existing gap, tracked as a follow-up), so CI is NOT a backstop. We therefore
# skip ONLY on a proven-safe classification and FAIL SAFE (run both) on any doubt:
# a parse error, a missing base, or a non-`true` value all leave run_size_weight=1.
# Never skipped under CI=1 (CI runs verify-fast unscoped), mirroring the eslint
# changed-files gate above.
run_size_weight=1
if [ -z "${CI:-}" ]; then
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  gameplay_safe="$(bash "$script_dir/ci/local-scope.sh" 2>/dev/null | grep -E '^gameplay_safe=' | tail -n1 || true)"
  if [ "$gameplay_safe" = "gameplay_safe=true" ]; then
    run_size_weight=0
  fi
fi

if [ "$run_size_weight" -eq 1 ]; then
  npx tsx scripts/agent/health/check-size-coverage.ts
  npx tsx scripts/agent/health/check-weight-coverage.ts
else
  echo "   ⏭️  Skipping size + weight coverage: change set is gameplay_safe (headless-sim inputs unchanged)."
  echo "      Force them with 'npm run check:size-coverage' / 'npm run check:weight-coverage'."
fi

echo "✅ Fast verification passed."

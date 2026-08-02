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
  [[ "$1" =~ ^(vite\.config\.ts|vitest\.config\.ts|vitest\.mutation\.config\.ts|(src|tests|scripts|tools)/.*\.(tsx?|mts|cts))$ ]]
}

# Returns true for .mjs files that are actively linted in changed-file mode.
is_linted_mjs_path() {
  [[ "$1" =~ ^\.github/scripts/.*\.mjs$ ]]
}

# Returns true for ALL .mjs locations known to exist in this repo.
# Files in these trees are not linted locally by verify:fast (CI covers them),
# but they must not be rejected as "unsupported" when someone edits them.
is_known_mjs_path() {
  [[ "$1" =~ ^(\.github/scripts/|\.github/extensions/|scripts/).*\.mjs$ ]]
}

# Decide ESLint scope. CI lints the whole tree (authoritative gate). Locally we
# lint only the files that changed vs the branch base + the working tree. This
# is safe: the ESLint config here has NO type-aware or cross-file rules
# (typescript-eslint "recommended" + per-file no-restricted-imports), and CI
# re-lints everything on the PR. It matters a lot — ESLint hashes all ~465 files
# for its cache even when nothing changed (~22s of pure overhead), whereas a
# typical change set is a handful of files (~3-5s), making this the biggest win
# on the most frequently run command.
LINT_CMD=(npx eslint vite.config.ts src/ tests/ scripts/ tools/ .github/scripts/ --cache --cache-location .cache/eslint/.eslintcache --max-warnings 0)
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  base="$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null || true)"
  # In CI, use GITHUB_BASE_SHA as a fallback when no local branch is resolvable
  # (e.g. shallow/detached checkout without origin/main fetched).
  if [ -z "$base" ] && [ -n "${GITHUB_BASE_SHA:-}" ]; then
    base="${GITHUB_BASE_SHA}"
  fi
  changed_repo_lint=()
  changed_repo_ts=()
  changed_repo_github_scripts_mjs=()
  changed_ts=()
  unsupported_ts=()
  changed_github_scripts_mjs=()
  unsupported_mjs=()
  while IFS= read -r f; do
    # Skip blanks and any path that no longer exists on disk. A file deleted or
    # renamed-away in this branch still shows up in the diff, but ESLint errors
    # when handed a path that isn't there — which would break the most
    # frequently-run command for the life of the branch.
    if [ -n "$f" ] && [ -f "$f" ]; then
      changed_repo_lint+=("$f")
      if [[ "$f" =~ \.(tsx?|mts|cts)$ ]]; then
        changed_repo_ts+=("$f")
      elif [[ "$f" =~ \.mjs$ ]]; then
        changed_repo_github_scripts_mjs+=("$f")
      fi
    fi
  done < <(
    {
      # --diff-filter=ACMR drops deletions (D) and reports renames at their new
      # path, so vanished paths never reach the existence check above.
      [ -n "$base" ] && git diff --name-only --diff-filter=ACMR "$base"
      git diff --name-only --diff-filter=ACMR
      git diff --name-only --diff-filter=ACMR --cached
      git ls-files --others --exclude-standard
    } 2>/dev/null | grep -E '\.(tsx?|mts|cts|mjs)$' | sort -u
  )
  # Fail safe only when we have no merge base AND no working-tree lintable code
  # changes. In that clean-checkout state, committed unsupported paths would be
  # invisible.
  if [ -z "$base" ] && [ "${#changed_repo_lint[@]}" -eq 0 ]; then
    echo "❌ verify:fast could not determine a git merge base for changed-file scanning." >&2
    echo "   Fetch origin/main or main locally, or set GITHUB_BASE_SHA in CI, before relying on verify:fast." >&2
    exit 1
  fi
  for f in "${changed_repo_ts[@]}"; do
    if is_supported_ts_path "$f"; then
      changed_ts+=("$f")
    else
      unsupported_ts+=("$f")
    fi
  done
  for f in "${changed_repo_github_scripts_mjs[@]}"; do
    if is_linted_mjs_path "$f"; then
      changed_github_scripts_mjs+=("$f")
    elif ! is_known_mjs_path "$f"; then
      unsupported_mjs+=("$f")
    fi
    # Known but non-.github/scripts paths (.github/extensions/, scripts/):
    # CI lints them in full-tree mode; verify:fast skips them locally.
  done
  if [ "${#unsupported_ts[@]}" -ne 0 ]; then
    echo "❌ verify:fast does not support changed TypeScript files outside vite.config.ts, vitest.config.ts, src/, tests/, scripts/, and tools/:" >&2
    printf '   - %s\n' "${unsupported_ts[@]}" >&2
    echo "   Move the file into a supported tree or extend verify:fast + tsconfig.json first." >&2
    exit 1
  fi
  if [ "${#unsupported_mjs[@]}" -ne 0 ]; then
    echo "❌ verify:fast does not support changed .mjs files outside .github/scripts/, .github/extensions/, or scripts/:" >&2
    printf '   - %s\n' "${unsupported_mjs[@]}" >&2
    echo "   Move the file into a known .mjs tree or extend verify:fast first." >&2
    exit 1
  fi
  if [ "$test_static_only" -eq 1 ]; then
    LINT_CMD=(true)
  elif [ -z "${CI:-}" ]; then
    changed_lint=("${changed_ts[@]}" "${changed_github_scripts_mjs[@]}")
    if [ "${#changed_lint[@]}" -eq 0 ]; then
      echo "   ✓ No changed TS or .github/scripts .mjs files to lint (full tree is re-linted in CI)."
      LINT_CMD=(true)
    else
      echo "   Linting ${#changed_lint[@]} changed file(s) (full tree is re-linted in CI)..."
      LINT_CMD=(npx eslint "${changed_lint[@]}" --cache --cache-location .cache/eslint/.eslintcache --max-warnings 0)
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
  # Follow up with SIGKILL to guarantee immediate termination without waiting
  # for SIGTERM handlers; this prevents descendants from surviving on loaded CI.
  kill -KILL -- -"$TSC_PID" -"$ESLINT_PID" 2>/dev/null || true
  # No blocking wait in the EXIT trap — the shell exits immediately after.
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

echo "🔍 Step 3/3: Data-contract + integrity + coverage checks..."
# physics-defs-sync is cheap and checks data drift (a docs-only entity-sizing.md
# edit is gameplay_safe yet must still be validated against the code), so it always
# runs.
npx tsx scripts/agent/health/check-physics-defs-sync.ts

# The three integrity guards below are pure JSON/file reads (no sim, no git, no
# subprocess) and together cost well under a second, so they always run — the
# whole point is that a data-contract break is caught at edit time rather than by
# a red CI job or, worse, by a human noticing broken art in-game.
#
#  - registry-integrity: duplicate/blank ids WITHIN a registry file and ACROSS
#    sibling files sharing one logical id namespace. The cross-file case is the
#    one no per-file loader can see (achievements.floor1 + floor2 tier collision).
#  - asset-integrity: the shard ↔ PNG ↔ contentHash triple over the entire
#    committed corpus, so a stale hash or an orphaned shard is found once rather
#    than by eye (welcome-room stale shard hashes, resurrected walk shard).
#  - allowlist-expiry: every governed allowlist entry still has a specific
#    reason and an unexpired / correctly-shaped deadline (npm audit exceptions
#    went red because an allowlist quietly expired on a date).
npx tsx scripts/agent/health/check-registry-integrity.ts
npx tsx scripts/agent/health/check-asset-integrity.ts
npx tsx scripts/agent/health/check-allowlist-expiry.ts

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

# ── Silent merge-revert guard (local, merge-commit-only) ────────────────────
# The CI job `check-silent-reverts` is the authoritative gate, but it only runs
# on `pull_request`. That made the guard purely post-hoc: two main-merges (PR
# #2022's Don Paco boss-ability rows, PR #2365's upstream test-only-exports
# wrapper) silently discarded upstream content and needed a human to notice and
# reconstruct it. Running the same guard the moment the merge is created moves
# the detection from "after review" to "before the next commit".
#
# Gated on the branch actually containing a merge commit so the overwhelmingly
# common linear-branch case pays nothing. Skipped (never failed) on a shallow
# clone or an unresolvable base: the guard fails closed by design, and a local
# shallow checkout is a tooling state, not a branch defect. CI re-runs it with
# fetch-depth: 0 on every PR, so skipping locally cannot weaken the gate.
if [ -z "${VERIFY_FAST_SKIP_SILENT_REVERTS:-}" ]; then
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  merge_scope="$(bash "$script_dir/ci/merge-scope.sh" 2>/dev/null || true)"
  has_merge="$(printf '%s\n' "$merge_scope" | grep -E '^has_merge=' | tail -n1 || true)"
  can_run="$(printf '%s\n' "$merge_scope" | grep -E '^can_run=' | tail -n1 || true)"
  if [ "$has_merge" = "has_merge=true" ] && [ "$can_run" = "can_run=true" ]; then
    echo "🔍 Extra step: Silent merge-revert guard (branch contains a merge commit)..."
    npx tsx scripts/agent/health/silent-reverts.ts
  elif [ "$can_run" = "can_run=false" ]; then
    echo "   ⏭️  Skipping silent merge-revert guard: history is not resolvable here"
    echo "      (shallow clone or no merge base). CI runs it on every PR with fetch-depth: 0."
    echo "      To run it locally: 'git fetch --unshallow origin' then 'npm run check:silent-reverts'."
  fi
fi

echo "✅ Fast verification passed."

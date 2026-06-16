#!/usr/bin/env bash
set -euo pipefail
export CI=1

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
npx tsc --noEmit &
TSC_PID=$!
npx eslint src/ tests/ scripts/ --max-warnings 0 &
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
set +e
run_with_timeout 30 npx vitest run --changed --project unit --reporter=dot
test_status=$?
set -e
if [ "$test_status" -eq 124 ]; then
  echo "❌ Fast verification timed out after 30s while running unit tests."
  exit 124
fi
if [ "$test_status" -ne 0 ]; then
  exit "$test_status"
fi

echo "✅ Fast verification passed."

#!/usr/bin/env bash
#
# merge-scope.sh — decides whether the LOCAL silent merge-revert guard can and
# should run on this branch.
#
# Background: `check:silent-reverts` is authoritative in CI (job
# `check-silent-reverts`, `fetch-depth: 0`), but it only runs on
# `pull_request`. That made it purely post-hoc — PR #2022 silently discarded
# Don Paco boss-ability rows and PR #2365 silently discarded an upstream
# `test-only-exports.ts` wrapper, and in both cases a human had to notice the
# loss and reconstruct it by hand. Running the same guard the moment the merge
# commit is created moves detection from "after review" to "before the next
# commit".
#
# Emits two flags on stdout:
#   has_merge=<bool>   branch contains >=1 merge commit vs the mainline base
#   can_run=<bool>     the guard can actually resolve history here
#   base_ref=<ref>     the mainline ref that resolved (origin/main or main)
#
# base_ref MUST be forwarded to the guard as SILENT_REVERT_BASE_REF. This
# classifier falls back to a local `main` when `origin/main` is absent (offline
# work), but the guard itself defaults to `origin/main`; without forwarding, an
# offline clone with only local `main` reports can_run=true and the guard then
# dies resolving a ref that does not exist.
#
# The guard itself fails CLOSED (exit 2) when it cannot resolve merge bases,
# which is right for CI but wrong for a developer's shallow clone: that is a
# tooling state, not a branch defect. So this classifier reports can_run=false
# for a shallow clone or an unresolvable base and the caller SKIPS rather than
# fails. Skipping locally can never weaken the gate because CI re-runs the same
# guard unconditionally on every PR.
#
# Consumed by verify-fast.sh. Unit-tested against synthetic git fixtures in
# tests/unit/merge-scope.test.ts.

set -euo pipefail

emit() {
  printf 'has_merge=%s\ncan_run=%s\nbase_ref=%s\n' "$1" "$2" "${3:-}"
}

# Not a git work tree (or git unavailable) → nothing to inspect, nothing to run.
if ! command -v git >/dev/null 2>&1 || ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "merge-scope: not a git work tree — guard cannot run." >&2
  emit false false
  exit 0
fi

# A shallow clone cannot resolve the merge bases the guard walks. Report it as
# not-runnable so the caller prints actionable remediation instead of failing.
if [ "$(git rev-parse --is-shallow-repository 2>/dev/null || echo true)" = "true" ]; then
  echo "merge-scope: shallow clone — guard cannot resolve merge bases." >&2
  emit false false
  exit 0
fi

# Resolve the merge base against the mainline: origin/main first (matches the
# base CI uses), then local main for offline work.
base_ref=''
if base="$(git merge-base HEAD origin/main 2>/dev/null)" && [ -n "$base" ]; then
  base_ref='origin/main'
elif base="$(git merge-base HEAD main 2>/dev/null)" && [ -n "$base" ]; then
  base_ref='main'
else
  echo "merge-scope: no merge base vs origin/main|main — guard cannot run." >&2
  emit false false
  exit 0
fi

# `--merges` lists commits with >1 parent. A git FAILURE here is not the same as
# "no merges": it means we could not determine the answer, so report
# can_run=false and let the caller skip with remediation text rather than
# silently concluding the branch is linear.
if ! merges="$(git rev-list --merges "$base..HEAD" 2>/dev/null)"; then
  echo "merge-scope: git rev-list failed — guard cannot run." >&2
  emit false false
  exit 0
fi

echo "merge-scope: base=${base} base_ref=${base_ref}" >&2

if [ -z "$(printf '%s' "$merges" | tr -d '[:space:]')" ]; then
  emit false true "$base_ref"
  exit 0
fi

emit true true "$base_ref"

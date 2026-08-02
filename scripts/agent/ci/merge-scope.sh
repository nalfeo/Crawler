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
  printf 'has_merge=%s\ncan_run=%s\n' "$1" "$2"
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
base="$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null || true)"
if [ -z "$base" ]; then
  echo "merge-scope: no merge base vs origin/main|main — guard cannot run." >&2
  emit false false
  exit 0
fi

# `--merges` lists commits with >1 parent. The trailing `|| true` keeps a
# transient git error from crashing under `set -o pipefail`; an empty result
# only ever degrades toward "no merge commit", and CI remains the backstop.
merges="$(git rev-list --merges "$base..HEAD" 2>/dev/null || true)"

echo "merge-scope: base=${base}" >&2

if [ -z "$(printf '%s' "$merges" | tr -d '[:space:]')" ]; then
  emit false true
  exit 0
fi

emit true true

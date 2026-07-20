#!/usr/bin/env bash
#
# local-scope.sh — working-tree-aware change-scope classifier for LOCAL runs.
#
# Wraps detect-art-only.sh (the CI classifier plus its unit-tested allowlists) but
# computes the changed-file set the way a developer's working tree actually looks:
# the union of committed branch changes (merge-base..HEAD) AND uncommitted work
# (staged + unstaged + untracked). It emits the same three flags on stdout:
#   art_only=<bool>
#   docs_only=<bool>
#   gameplay_safe=<bool>
#
# Consumed by `npm run scope` (item 1: a pre-run gate for heavy discretionary work
# like the headless sim / weapon sweeps / visual review) and by verify-fast.sh
# (item 5: skip the two headless-sim coverage checks when the change set provably
# cannot affect the sim).
#
# SAFETY — never grant a false "safe" skip:
#   - A safe skip requires a RESOLVED merge base. If none resolves we cannot see
#     the committed branch changes, so classifying from working-tree data alone
#     could hide a src/core change on an earlier commit. In that case we refuse
#     and force all-false (run everything).
#   - The diffs use NO --diff-filter, so deletions and renames ARE included:
#     deleting a src/core file correctly forces gameplay_safe=false. (Contrast the
#     eslint scoping in verify-fast.sh, which uses ACMR precisely because it feeds
#     paths to a tool that needs them to still exist on disk.)
#   - detect-art-only.sh's own fail-safe (empty set → all-false) covers a clean
#     tree, and any git error degrades toward more files / all-false, never toward
#     a spurious "safe".

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

emit_all_false() {
  # Mirror detect-art-only.sh's fail-safe output contract exactly so consumers can
  # parse one shape regardless of which path produced it.
  # Legacy flags (safe/only): false → broader gates run.
  # New positive-contract flags: true → fail toward broader validation when
  # scope cannot be determined (consistent with detect-art-only.sh fail-safe).
  printf 'art_only=false\ndocs_only=false\ngameplay_safe=false\nsprites_only=false\nsprites_touched=true\nsim_touched=true\ncoverage_touched=true\nsprite_pipeline_touched=true\ndependencies_touched=true\nvisual_touched=true\ngame_visual_touched=true\nasset_visual_touched=true\ndevtool_visual_touched=true\n'
}

# Not a git work tree (or git unavailable) → cannot compute a trustworthy set.
if ! command -v git >/dev/null 2>&1 || ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "local-scope: not a git work tree — forcing full-suite (all-false)." >&2
  emit_all_false
  exit 0
fi

# Resolve the merge base against the mainline. origin/main first (matches CI's
# PR base), then local main as a fallback for offline work.
base="$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null || true)"
if [ -z "$base" ]; then
  echo "local-scope: no merge base vs origin/main|main — forcing full-suite (all-false)." >&2
  emit_all_false
  exit 0
fi

# Union of committed branch changes (base..HEAD) + all uncommitted work. NO
# --diff-filter anywhere, so deletions/renames are included and correctly force
# not-safe. The trailing `|| true` keeps a transient git error from crashing under
# `set -o pipefail`; a partial/empty set only ever degrades toward all-false.
changed="$(
  {
    git diff --no-renames --name-only "$base" HEAD
    git diff --no-renames --name-only
    git diff --no-renames --name-only --cached
    git ls-files --others --exclude-standard
  } 2>/dev/null | sort -u || true
)"

echo "local-scope: base=${base}" >&2

# Empty working-tree union should fail closed for local heavy-check gating.
if [ -z "$(printf '%s' "$changed" | tr -d '[:space:]')" ]; then
  echo "local-scope: no changed files detected — forcing full-suite (all-false)." >&2
  emit_all_false
  exit 0
fi

# Hand the working-tree-aware set to the shared CI classifier via its documented
# test hook. SCOPE_FILES_OVERRIDE is presence-detected (${VAR+x}) there, so even
# an empty set is honored as an empty change set → all-false (run everything).
SCOPE_FILES_OVERRIDE="$changed" GITHUB_OUTPUT='' bash "$script_dir/detect-art-only.sh"

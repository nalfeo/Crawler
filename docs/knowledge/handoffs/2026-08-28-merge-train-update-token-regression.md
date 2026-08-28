# Merge-train update token regression

## Date

2026-08-28

## Persona

DevOps Engineer

## Systems touched

merge-train, ci-policy

## Apples

2🍎 estimated, 2🍎 actual (exact).

## Summary

Restored the credential contract already implemented by
`resolveMergeTrainTokens`: the merge-train reconcile step now receives
`CRAWLER_CI_PAT`, so clean-`BEHIND` updates use a repository write credential
whose pushes trigger normal CI. The workflow previously omitted that secret,
forcing the code to fall back to its read-only, recursion-suppressed
`GITHUB_TOKEN`.

Updated deterministic workflow coverage to require the PAT only on the trusted
reconcile step and continue forbidding it from unrelated steps. Added the
canonical CI recovery investigation order: establish the last-known-good
boundary, inspect regressions and logs, and prefer a systemic fix before adding
repair complexity.

## Evidence

The pre-change workflow declared `contents: read`, supplied `GITHUB_TOKEN` and
the repository App token to reconcile, but omitted `CRAWLER_CI_PAT`. The
reconciler explicitly selects `CRAWLER_CI_PAT || GITHUB_TOKEN` for
`update-branch`, so the intended credential path was unreachable.

Recent Merge Train run `33201981006` confirmed the workflow still executes the
trusted default-branch reconcile and quarantine-repair steps. This change is
CI tooling only; no shipped runtime artifact is affected.

# Merge-train update token regression

## Date

2026-08-28

## Persona

DevOps Engineer

## Systems touched

ci-policy

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

`verify:fast` also exposed an unrelated test/implementation drift already
tracked by PR #3850: Goobers workflow assertions still expected the
pre-fallback credential names and values. Synchronized those assertions with
the shipped workflow so this PR does not preserve a red `main` baseline.

## Evidence

The pre-change workflow declared `contents: read`, supplied `GITHUB_TOKEN` and
the repository App token to reconcile, but omitted `CRAWLER_CI_PAT`. The
reconciler explicitly selects `CRAWLER_CI_PAT || GITHUB_TOKEN` for
`update-branch`, so the intended credential path was unreachable.

Recent Merge Train run `33201981006` confirmed the workflow still executes the
trusted default-branch reconcile and quarantine-repair steps. This change is
CI tooling only; no shipped runtime artifact is affected.

## Retrospective

### Lessons Learned

Credential-contract regressions are easiest to diagnose by comparing the
workflow environment against the helper that resolves the credential, not by
starting with new retry or quarantine logic. The intended
`CRAWLER_CI_PAT || GITHUB_TOKEN` fallback already existed, so the minimal repair
was to restore the missing workflow input.

### Mistakes Made

The initial handoff used the local subsystem name `merge-train` as a system
slug even though `docs/systems/README.md` canonicalizes this area as
`ci-policy`. It also stopped before the required retrospective block, which
would have let the current advisory lint skip the most useful session lessons.

### Opportunities for Future Improvement

The handoff checker could reject new handoffs that omit `## Retrospective`
instead of grandfathering every file without that heading. That would catch the
same omission immediately while preserving existing archived handoffs through a
dated or explicit allowlist.

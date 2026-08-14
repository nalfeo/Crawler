# Session Handoff: docs-update prereq recovery

## Date

2026-08-14

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 2🍎, actual 2🍎.

## What Was Done

Recovered PR #2907 by merging current `origin/main`, reclassifying `2026-08-02-velocity-bottleneck-guard-remediation.md` from the invalid `tooling` slug to `ci-policy`, and regenerating `docs/knowledge/handoffs/INDEX.md`. While running required PR prereqs, fixed the wrapper so `npm run verify:pr-prereqs` passes the current branch and merge base into the existing preflight guard, preserving the `automation/docs-update` exemption for generated `INDEX.md` changes.

## Key Decisions Made

Kept the generated index in the docs-update PR because the PR's stated purpose is to deliver `docs/knowledge/handoffs/INDEX.md`; restoring it to the merge base would have contradicted the recovery request. The wrapper fix only forwards already-available git context into the existing guard helper rather than changing guard policy.

## What's Next / Blockers

No known blockers after validation. CI recovery should resolve the review thread once the marker reply lands on the exact review comment.

## Retrospective

### Lessons Learned

The `pr-preflight` guard already had an `automation/docs-update` exemption, but the local `verify:pr-prereqs` wrapper can still diverge if it does not pass the same branch context into `evaluatePreflightChecks`.

### Mistakes Made

I initially treated the prereq failure as a likely policy false positive and only then inspected the wrapper path; the early signal was that the guard unit test already covered `automation/docs-update`, so the failing path had to be the CLI adapter rather than the guard rule itself.

### Opportunities for Future Improvement

Add CLI-level tests around other guard context fields so wrapper drift is caught before docs-update recovery PRs hit the same local validation failure.

# CI Recovery Loop Investigation — PR #1886 (Second Incident) — ADR Enrichment

**Date:** 2026-07-29  
**Session slug:** `ci-recovery-loop-pr-1886-adr-enrichment`  
**Apple estimate:** 1🍎 (docs-only enrichment; no code changes)  
**Closes:** #2269  
**Related:** PR #1886, issue #2033 (prior loop incident), handoff `2026-07-25-ci-recovery-loop-pr-1886.md`

## Systems touched

ci-recovery, sprite-pipeline

## Summary

Investigated why the CI recovery automation failed to converge on PR #1886 a second
time (issue #2269, after the first loop incident issue #2033). Confirmed the same root
cause as the prior investigation, found no new code defect, and applied the ADR
documentation enrichment that PR #1886 intended to land.

## Root Cause (Confirmed — Same as First Incident)

All CI recovery dispatch attempts fail at `session.create`:

```
[cca-engine] Error: Request session.create failed with message:
Model "claude-sonnet-4.5" is not available.
```

The Copilot SWE agent is configured (via repository/org settings `settings="auto"`)
to use `claude-sonnet-4.5`, which was deprecated on 2026-05-06. Every `fix-pr-comment`
CCA job dispatched by CI recovery exits in ~65 seconds with this fatal error before
doing any work.

## Defect Analysis

| Component                                    | Finding                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Marker parser** (`extractAddressedMarkerSha`) | ✓ Correct. All 157 `reconcile.test.mjs` tests pass.                                                        |
| **Thread-resolution path** (`shouldResolveThread`) | ✓ Correct.                                                                                               |
| **Permission grant**                         | ✓ Correct. `CRAWLER_CI_PAT` discovers the Copilot actor and the GraphQL assign mutation succeeds.             |
| **Mutation sequence**                         | ✓ Correct. Posts task, assigns Copilot, tracks ownership, retries, files loop incident at `attempt >= 2`.    |
| **Fingerprint churn handling**               | ✓ Correct (see reconcile.test.mjs lines 12355–12650). URL-excluded fingerprint prevents infinite attempt-reset. |

**No deterministic code defect exists.** The loop is caused entirely by external
infrastructure: the deprecated `claude-sonnet-4.5` model is resolved from
`settings="auto"` in the repository/org Copilot configuration.

## Why the Second Incident Happened

The prior session (2026-07-25 handoff) documented that after nalfeo manually resolved
one review thread, the reconcile automation restarted from a clean baseline
(`attempt: 0`) and dispatched a new cloud Copilot agent at ~20:56:33Z. That dispatch
also failed with the deprecated model. The three remaining unresolved review threads
(`TeviL`, `TeviX`, `Teviw`) were never given `✅ Addressed` marker replies, so CI
recovery continued looping until `attempt >= 2` and filed a second loop incident
(issue #2269).

## PR #1886 Status

PR #1886 (`feat: retire foundry backend, standardize asset pipeline on azure-openai`)
is `mergeable_state: dirty`. Its actual code changes were already incorporated into
`main` (by a separate path), making the PR obsolete for code purposes. If merged as-is,
PR #1886 would **regress** `main` by:

- Removing `SPRITES_PROVIDER: azure-openai` explicit overrides from `asset-request.yml`
- Removing `contents: write` and `pull-requests: write` permissions needed for art push
- Removing `CRAWLER_CI_PAT` checkout token needed for CI trigger chain
- Removing foundry-specific rejection tests from `factory.test.ts`
- Weakening the `asset-request-workflow` contract test

**Recommendation:** Close PR #1886 as superseded by `main`. The unique value from
that PR (richer ADR history/context) is captured in this PR instead.

## Fix Applied

ADR 0033 and ADR 0072 enriched with the detailed history from PR #1886:

- **ADR 0033**: Superseded status now uses bold formatting, hyperlinks to ADR 0072,
  and explains WHY the migration was not pursued (zero deployments, 400 failures).
- **ADR 0072**: Added "Why the migration failed" section with 4 numbered points,
  westus3 quota snapshot table, detailed "Changes" and "What is kept" sections,
  positive/negative consequences breakdown, "Alternatives Considered", and "Non-Goals".

## Repair Path for PR #1886 (if a reviewer wants to close the loop)

The three unresolved review threads on PR #1886 (`TeviL`, `TeviX`, `Teviw`) are
each addressed in the current PR #1886 branch commit `a806d4b7` AND in `main`. A
maintainer can resolve them manually in the GitHub UI or post `✅ Not applicable:
foundry retirement already complete in main` to each thread. Either action will
change the blocker fingerprint, causing CI recovery to restart cleanly and eventually
close or escalate the PR.

Alternatively, closing PR #1886 directly will cause CI recovery's next reconcile
run to detect the closed state and terminate the dispatch loop without filing
further incidents.

## Regression Test Status

No new test needed. The `reconcile.test.mjs` fingerprint-churn tests (lines 12355–12650,
"PR #1809 cycle 2/3" and "PR #1809 cycle 3/3") already cover the exact failure pattern:
a self-generated Copilot check failure causes URL churn, the fingerprint (URL-excluded)
stays stable, the retry ceiling is reached, and the loop incident is filed.

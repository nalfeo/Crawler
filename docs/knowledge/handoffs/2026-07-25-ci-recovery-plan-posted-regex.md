# Handoff: ci-recovery plan-detection regex fix

**Date:** 2026-07-25  
**Session slug:** ci-recovery-plan-posted-regex  
**Closes:** #2018 (CI recovery loop incident for PR #2006)  
**Apple estimate:** 🍎 (1)

## Systems touched

ci-policy

## Root cause

The CI recovery reconciler has a feature that auto-posts a retroactive plan comment on a
linked source issue when a reviewer thread flags a missing pre-PR plan. This is
implemented via `reviewThreadPlanIssueNumbers()` in
`.github/scripts/ci-recovery/issue-intake-lib.mjs`.

The function uses a `mentionsMissingPlanRequirement` regex whose `planSubject` recognises
only three exact phrases as valid plan-subject nouns:

- "plan comment"
- "implementation plan"
- "issue comment itself"

The reviewer on PR #2006 (thread `PRRT_kwDOSvo2Ms6Tv5TW`) wrote:

> "Issue #1934 explicitly required the detailed **plan to be posted on the issue** before
> any code was written."

The phrase "plan to be posted" is not any of the three recognised terms, so
`mentionsMissingPlanRequirement` returned `false`. As a result:

1. `retroactivePlanIssueNumbers` stayed empty.
2. The reconciler never posted the retroactive plan comment on Issue #1934.
3. The repair agent was dispatched without that context, said it had no issue-comment
   write tool, and left the thread unresolved.
4. After 2 failed dispatch attempts the loop-incident guard created issue #2018.

## Fix

Extended the regex in `reviewThreadPlanIssueNumbers()` with a third alternative:

```
\b(?:missing|required|requires?)\b[^.!?]{0,60}?\bplan\s+to\s+be\s+posted\b
```

This matches any sentence-fragment where "required/missing/requires" appears within 60
non-sentence-boundary characters of the phrase "plan to be posted", covering:

- "required the detailed plan to be posted on the issue" ← the exact failing phrase
- "required a plan to be posted"
- "required the plan to be posted before merging"

The `[^.!?]{0,60}?` constraint (non-greedy, stops at sentence boundaries) prevents the
alternative from spanning across multiple sentences.

The subsequent closing-issue-number gate still applies, so a false-positive match is
harmless unless the thread comment also contains a valid closing-issue reference.

## Files changed

- `.github/scripts/ci-recovery/issue-intake-lib.mjs` — regex extension
- `.github/scripts/ci-recovery/issue-intake.test.mjs` — regression tests for the exact
  reviewer phrasing (verbatim), plus two simpler variations and one true-negative case

## Verification

- All 456 CI-recovery unit tests pass (`node --test .github/scripts/ci-recovery/*.test.mjs`).
- `npm run verify:fast` passes (1698 tests, typecheck, lint, physics-defs).

## What happens next (PR #2006)

On the next CI-recovery sweep for PR #2006:

1. `reviewThreadPlanIssueNumbers` will return `[1934]` for the unresolved thread.
2. `retroactivePlanIssueNumbers` will contain `1934`.
3. The reconciler will fetch Issue #1934 comments, confirm the intake requirement comment
   is present and no plan comment exists, then post a retroactive plan comment with the
   `<!-- crawler-ci-recovery-plan:v1 -->` idempotency marker.
4. On the following sweep, `hasCopilotPlanComment` will return `true` for Issue #1934.
5. The repair agent can then post `✅ Not applicable: retroactive plan posted on Issue
   #1934 by CI recovery pipeline` on the review thread to close the blocker.

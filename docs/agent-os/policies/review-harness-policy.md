# Review Policy — Risk-Based Review

## Purpose

Apply independent review where failure would have meaningful consequences.
Tests and deterministic CI remain the merge gates. Before opening every PR, run
a fresh local Ducky review against the complete diff (`codex review
--uncommitted`), fix every blocking and medium finding, and rerun affected
checks. Human or model review happens after the diff exists.

No review stage is judged by CI. No review ledger, independent grade, or
repository-local review record is required or permitted. A short Codex/Ducky
attestation stating that review passed and the change is okay to check in may be
placed in the PR description, a commit message, or a PR comment. Any of those is
acceptable review evidence; none is a merge-admission requirement.

## Review trigger

Request one independent post-diff review when the change is architectural or
carries meaningful correctness, security, data-loss, determinism, or release
risk. Routine, reversible changes use focused tests and CI. A review must inspect
the complete current diff and relevant callers/tests. Address valid findings and
request another review when a fix materially changes the diff.

For published changes, request additional independent review when the risk
trigger applies and resolve findings in their native review threads. CI Recovery
acts on CI failures and unresolved PR threads only; the presence or provider of
a review attestation is never a blocker.

## Architectural design review

Adversarial design review is required **only when the change is architectural**:
it introduces or changes a load-bearing system boundary, cross-system contract,
or durable architecture decision.

Run it before implementation, enumerate at least two credible alternatives, and
record the chosen decision in the applicable ADR or PR discussion.

## Workflow

1. If the change is architectural, run the adversarial design review.
2. Implement and run the deterministic tests appropriate to the diff.
3. Run a fresh local Ducky review of the complete diff.
4. Fix every blocking and medium Ducky finding, then rerun affected tests.
5. Run `npm run verify:fast` and `npm run verify:pr-prereqs`.
6. If the risk trigger applies, obtain one additional independent post-diff review.
7. Optionally record a concise Codex/Ducky pass attestation in the PR
   description, a commit message, or a PR comment.

## 30-PR pilot

The first 30 merged PRs governed by this policy form the pilot cohort. Compare
them with the immediately preceding 30 merged PRs, using GitHub timestamps,
reviews, threads, commits, linked regression issues, and CI Recovery state.

The pilot succeeds only if all three gates pass:

1. **Zero ledger-caused blockers** in the pilot cohort.
2. **At least 25% lower median PR cycle time**, measured from PR creation to
   merge.
3. **No increase in review rework or post-merge regressions**:
   - review rework = median commits pushed after the first review;
   - post-merge regressions = merged pilot PRs linked to a regression issue or
     revert within 14 days.

Report cohort counts and raw medians/counts. A missing sample or unavailable
GitHub evidence is “inconclusive,” never a pass. Use deterministic repository or
GitHub data collection; no LLM judges the pilot.

## Retired system

The former committed review-ledger corpus, validator/CLI, independent grader,
plan-divergence field, ledger guard, ledger CI validation, and CI Recovery
ledger blockers are deleted. Historical ADRs and handoffs remain unchanged as
evidence of the policy that applied when they were written.

## Cross-links

- Operator playbook: [`.github/skills/review-harness/SKILL.md`](../../../.github/skills/review-harness/SKILL.md)
- Change risk: [`change-risk-policy.md`](change-risk-policy.md)
- PR review contract: [`.github/instructions/review.instructions.md`](../../../.github/instructions/review.instructions.md)

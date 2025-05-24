# 2026-07-18 — Repair empty Copilot draft shells

## Systems touched

ci-policy

## Summary

Extended the existing `pr-ready-reviewer-guard` workflow so it can deterministically
repair only the exact empty Copilot draft-PR shell fixture instead of leaving those
PRs parked forever in draft.

The workflow now runs trusted default-branch code from
`.github/scripts/pr-ready-reviewer-guard.mjs`, preserving the existing behavior that:

1. Publishes draft PRs only after the existing bounded changed-file retry observes
   at least one changed file.
2. Removes the configured requested reviewer exactly as before.

On top of that preserved behavior, the guard now adds one fail-closed repair path
for empty Copilot draft shells:

1. Require an open same-repo draft PR from a recognized Copilot identity.
2. Require zero changed files after the existing bounded consistency handling.
3. Require exactly one linked **open** closing issue.
4. Require the newest matching Copilot cloud-agent workflow run on the exact head
   branch + head SHA to be completed and older than a short grace period.
5. Re-fetch and re-confirm the PR + linked issue before the first write so head
   drift and linked-issue changes fail closed.
6. Re-fetch the linked issue’s assignable context, require it to still be open,
   and require Copilot to still be an assignee.
7. Perform exactly one audited repair: close the PR, remove Copilot from the issue,
   then re-add Copilot while preserving the other assignees.

Any non-eligible or ambiguous case logs an explicit skip reason and performs zero
repair writes. If any post-close step fails, the workflow restores the original
issue assignee set, reopens the PR, and surfaces the failure instead of swallowing
it.

## Files touched

- `.github/workflows/pr-ready-reviewer-guard.yml`
- `.github/scripts/pr-ready-reviewer-guard.mjs`
- `.github/scripts/pr-ready-reviewer-guard.test.mjs`
- `.github/scripts/ci-recovery/github.mjs`
- `.github/scripts/ci-recovery/issue-intake-lib.mjs`
- `.github/scripts/ci-recovery/issue-intake.test.mjs`
- `docs/knowledge/review-ledgers/2026-07-18-repair-empty-copilot-drafts.review-ledger.json`

## Verification

- Focused node tests:
  `node --test .github/scripts/pr-ready-reviewer-guard.test.mjs .github/scripts/ci-recovery/issue-intake.test.mjs`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-18-repair-empty-copilot-drafts.review-ledger.json`

## Review harness

- Estimate/actual: 3🍎 / 3🍎
- Plan review (`gpt-5.4`): 4 concerns resolved, `plan_divergence=minor`
- Code review loop (`claude-sonnet-4.6`): round 1 surfaced two issues; round 2
  surfaced one final TOCTOU issue; all three were resolved and the ledger records
  a clean terminal round

## Unresolved issues

None known.

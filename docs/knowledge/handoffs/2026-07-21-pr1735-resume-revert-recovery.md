# Handoff — PR #1735 cross-run resume revert recovery

## Systems touched

ai-combat-balance, ci-policy

## Summary

- Reverted the AI Sweep cross-run resume subsystem from PR #1735 by restoring `.github/workflows/ai-sweep.yml`, `scripts/agent/perf/round-plan.ts`, `scripts/agent/perf/sweep-eval.ts`, and the matching workflow/unit tests to their pre-resume `df498098` state.
- Removed the resume-only audit artifacts (`2026-07-21-ai-sweep-cross-run-resume.*`) plus the now-superseded `2026-07-21-pr1735-blocker-recovery.*` handoff/ledger so the branch no longer documents a feature that is not shipping.
- Preserved the earlier net-win promotion gate, round-eval `max-parallel: 8` cap, LEGACY-baseline hardening, and security fix already on the branch.

## Why

Two still-open PR blockers were both rooted in the post-scope-creep cross-run resume work:

1. mixed resume/fresh runs could initialize fresh non-LEGACY combos without the canonical LEGACY incumbent, reintroducing the exact in-search trajectory bug this PR had already fixed elsewhere; and
2. the PR description never described the production resume feature, while the review explicitly allowed either a holistic PR-body rewrite or splitting/reducing the change.

Given the available tools in this session, the smallest correct recovery was to split the branch back down to its original net-win scope instead of continuing to widen and repair the resume subsystem in place.

## Verification

- `npm run format:check` ✅
- `npx vitest run tests/unit/ai-sweep-workflow.test.ts tests/unit/ai/sweep-round-plan.test.ts` ✅ (73/73)
- `npm run verify:fast` ✅
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-21-pr1735-resume-revert-recovery.review-ledger.json` ✅
- `npm run verify:pr-prereqs` ✅

## Review harness

- 3🍎 session.
- Separate-model plan review (`gpt-5.4`) approved with 2 concerns; both resolved. `plan_divergence=major_fork` because the recovery strategy changed from “fix resume in place” to “revert resume entirely”.
- Code-review loop: round 1 found 2 real concerns (unstaged deletions/new ledger, incomplete code-review stage); fixed before the terminal clean pass.

## Notes

- This recovery intentionally does **not** add any new runtime/workflow behavior. It only removes the unreviewed cross-run resume expansion so PR #1735 matches the branch scope already described in the PR body.

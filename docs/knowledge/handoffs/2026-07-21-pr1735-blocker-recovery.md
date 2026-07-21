# Handoff — PR #1735 blocker recovery

## Systems touched
ai-combat-balance, ci-policy

## Summary

- Resolved the requested review blocker in `assertResumeCompatible` by restoring exact `workflowSha` compatibility checks in `scripts/agent/perf/round-plan.ts`, so resume pre-check no longer accepts checkpoints that downstream shard/validate gates would reject.
- Updated `tests/unit/ai/sweep-round-plan.test.ts` to assert `workflowSha` mismatch is rejected.
- Reclassified the stale cross-run-resume ledger to 3🍎 with required `plan_review` and `code_review` stages.
- Added a new session review ledger (`2026-07-21-pr1735-blocker-recovery.review-ledger.json`) and completed/validated required 3🍎 stages.

## Files touched

- `scripts/agent/perf/round-plan.ts`
- `tests/unit/ai/sweep-round-plan.test.ts`
- `docs/knowledge/review-ledgers/2026-07-21-ai-sweep-cross-run-resume.review-ledger.json`
- `docs/knowledge/review-ledgers/2026-07-21-pr1735-blocker-recovery.review-ledger.json`

## Verification run

- `npx vitest run tests/unit/ai/sweep-round-plan.test.ts` ✅ (75/75)
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-21-ai-sweep-cross-run-resume.review-ledger.json` ✅
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-21-pr1735-blocker-recovery.review-ledger.json` ✅
- `npm run verify:fast` ✅

## CI / workflow check

- Queried PR #1735 check runs via GitHub MCP (`get_check_runs`): latest required CI jobs on head `5b62f57` were green; only current in-progress copilot job remained active at inspection time.
- Pulled failed-job logs for latest CI run (`run_id=29815924139`): no failed jobs reported.

## Unresolved issues

- Exact `workflowSha` matching narrows cross-run resume eligibility to checkpoints produced from the same commit SHA as the resumed run. This was applied intentionally to satisfy the explicit PR blocker thread and align resume pre-check with downstream strict provenance checks.

## Recommended next steps

1. Push this recovery patch and re-run PR checks.
2. Reply on the required review threads with addressed markers referencing the new commit SHA.
3. If resume ergonomics across commits is still desired, propose a follow-up design that updates all downstream provenance gates consistently (pre-check, shard merge, and final validate).

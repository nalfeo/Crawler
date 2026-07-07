## Summary

Implemented one clean, main-based triage-fixes slice with strict scope discipline across four requested buckets:

- check-in reliability hardening (`--no-verify` in throwaway worktree commit/push path),
- resilient githook Prettier resolution for worktree/nested repo layouts,
- status-correct placeholder filtering for approved-art parsing in plan/workflow surfaces,
- wide-sprite preview rendering fix for run-candidate/run-detail previews (preserve natural aspect ratio).

## Systems touched

sprite-pipeline, sprite-workflow, devtools, ci-policy

## Files touched

- `.githooks/pre-commit`
- `.githooks/pre-push`
- `scripts/sprites/asset-plan.ts`
- `scripts/sprites/checkin.ts`
- `src/devtools-main.ts`
- `src/devtools/art-plan-model.ts`
- `tests/unit/devtools-art-plan-model.test.ts`
- `tests/unit/devtools-main-wide-sprite-preview-guards.test.ts`
- `tests/unit/sprites/asset-plan.test.ts`
- `tests/unit/sprites/checkin.test.ts`
- `docs/knowledge/review-ledgers/2026-07-07-clean-triage-fixes-pr.review-ledger.json`

## Verification run

- `npm run test -- tests/unit/sprites/checkin.test.ts tests/unit/sprites/asset-plan.test.ts tests/unit/devtools-art-plan-model.test.ts tests/unit/devtools-main-wide-sprite-preview-guards.test.ts`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-07-clean-triage-fixes-pr.review-ledger.json`
- `npm run verify:pr-prereqs`

## Unresolved issues

- None in scope.

## Recommended next steps

- Merge this PR as a single coherent triage bundle.
- Optionally run `npm run telemetry:capture -- clean-triage-fixes-pr` to commit non-blocking guard telemetry for this session.

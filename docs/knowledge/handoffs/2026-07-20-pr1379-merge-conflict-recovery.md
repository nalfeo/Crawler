# PR #1379 merge-conflict recovery

## Date

2026-07-20

## Persona

DevOps Engineer

## Systems touched

inventory, weapons, ci-policy

## Apples

Estimated: 2🍎. Actual: 2🍎. Verdict: exact.

## What changed

- Merged `origin/main` into `nalfeo-generated-instance-registry` as commit
  `48758fa7d3947566a8ead14c6fa75e8123ad0526`.
- Resolved the 18 reported conflicts by taking the current `main` versions where
  upstream had already advanced the same generated-equipment, epic-status, and
  related contract surfaces beyond this branch snapshot.
- Revalidated the conflicted registry and epic-status suites on the merged tree.
- Confirmed the PR had no open review threads, so no thread replies or
  `✅ Addressed` markers were required for this recovery pass.

## Files touched

- `.github/workflows/epic-drift-audit.yml`
- `.specify/specs/weapon-system.md`
- `docs/knowledge/adr/0065-versioned-frozen-floor2-equipment-instances.md`
- `docs/knowledge/epics/floor-2-equipment/PLAN.md`
- `docs/knowledge/epics/floor-2-equipment/epic-state.json`
- `docs/knowledge/epics/floor-2-equipment/epic-state.schema.json`
- `docs/knowledge/handoffs/2026-07-17-floor-2-equipment-contracts.md`
- `docs/knowledge/handoffs/2026-07-17-floor-2-stacked-work-protocol.md`
- `docs/knowledge/handoffs/INDEX.md`
- `package.json`
- `scripts/agent/epics/epic-status-lib.ts`
- `scripts/agent/epics/epic-status.ts`
- `src/core/generated-equipment-registry.ts`
- `src/shared/canonical-json.ts`
- `src/shared/generated-equipment-types.ts`
- `src/shared/index.ts`
- `tests/unit/agent/epic-status.test.ts`
- `tests/unit/generated-equipment-registry.test.ts`
- `docs/knowledge/review-ledgers/2026-07-20-pr1379-merge-conflict-recovery.review-ledger.json`
- `docs/knowledge/handoffs/2026-07-20-pr1379-merge-conflict-recovery.md`

## Validation

- `npx vitest run tests/unit/generated-equipment-registry.test.ts tests/unit/agent/epic-status.test.ts`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-20-pr1379-merge-conflict-recovery.review-ledger.json`
- `npm run verify:pr-prereqs`

## Unresolved issues

- None inside the repository worktree. The recovery request only listed the merge
  conflict blocker, and that blocker is cleared locally.

## Recommended next steps

- Push the merge-recovery commit plus this session’s ledger/handoff artifacts to
  the PR branch.
- Let CI re-run on head `48758fa7d3947566a8ead14c6fa75e8123ad0526`.

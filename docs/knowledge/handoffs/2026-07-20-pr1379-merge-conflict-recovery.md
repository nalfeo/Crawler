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
- As a consequence, this branch's net diff no longer carried the original B1
  generated-instance-registry implementation payload.
- Revalidated the conflicted registry and epic-status suites on the merged tree.

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

- PR #1379 metadata still describes the original B1 implementation scope and
  closes #1289, but this recovery branch's net diff is now recovery/docs-only.
  Coordinator follow-up is required to either restore the intended B1 payload or
  update/close the PR without closing #1289 here.

## Recommended next steps

- Push the merge-recovery commit plus this session’s ledger/handoff artifacts to
  the PR branch.
- Let CI re-run against the branch's current head commit at dispatch time.

# Handoff: PR #1265 merge recovery

## Date

2026-07-18

## Persona

Producer

## Systems touched

docs-tooling

## Apples

Estimated 3 apples, actual 2 apples.

## What changed

- Merged `origin/main` into `copilot/floor-2-equipment-epic` and resolved the three
  Floor 2 epic add/add conflicts by adopting the newer canonical control-plane
  artifacts already on main:
  - `docs/knowledge/epics/floor-2-equipment/PLAN.md`
  - `docs/knowledge/epics/floor-2-equipment/epic-state.json`
  - `docs/knowledge/epics/floor-2-equipment/epic-state.schema.json`
- Kept the canonical `epic:status` entrypoint on
  `scripts/agent/epics/epic-status.ts`.
- Removed the superseded branch-local A0 implementation and its stale evidence:
  - `scripts/agent/epic-status-lib.ts`
  - `scripts/agent/epic-status.ts`
  - `tests/unit/epic-status.test.ts`
  - `docs/knowledge/handoffs/2026-07-17-floor2-equipment-a0*.md`
  - `docs/knowledge/metrics/apples/2026-07-17-floor2-equipment-a0*.json`
  - `docs/knowledge/review-ledgers/2026-07-17-floor2-equipment-a0.review-ledger.json`

## Verification run

- `npx vitest run tests/unit/agent/epic-status.test.ts`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Unresolved issues

- The historical issue-level "post a detailed plan comment before coding" checkpoint
  on issue `#1264` cannot be retroactively satisfied by code changes in this branch.
  The stale A0 artifact set that triggered that thread was removed in favor of the
  canonical control plane now on `main`.

## Recommended next steps

- Reply on the old review threads noting that the original A0 artifact set was
  superseded by the merge-to-main recovery and that the current branch no longer
  carries that implementation.

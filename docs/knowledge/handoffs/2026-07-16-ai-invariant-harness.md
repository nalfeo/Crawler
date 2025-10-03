# Handoff: Deterministic AI invariant harness

## Date

2026-07-16

## Persona

QA Engineer

## Systems touched

ai-behavior-tree, ai-pathfinding

## Apples

3 apples estimated, 3 apples actual (exact) - shared deterministic fixture,
cross-mode invariant matrix, and required two-round review loop.

## What Was Done

- Added a reusable AI invariant fixture that defines the hard-gate invariant
  taxonomy, Slice A decision/pathing axes, deterministic trace shape, and
  invariant-by-mode applicability contract.
- Added a 20-case matrix covering objective and door replanning, NPC interaction
  anchors, partial-path rejection, critical-route ownership, committed-detour
  accounting, stall recovery, and deterministic replay in both legacy and
  slack-aware decision modes.
- Preserved an explicit locomotion ownership seam so downstream pathing slices
  can extend the same invariants without creating a parallel harness.
- Moved applicability gap detection into the Vitest body after review identified
  that the original collection-time throw made the test assertion vacuous.

## Verification

- `npx node@22 node_modules/vitest/vitest.mjs run tests/game/ai-invariant-matrix.test.ts`
  passed: 1 file, 20 tests.
- `npm run verify:fast` passed under Node 22, including typecheck, changed tests,
  physics-definition sync, size coverage, and weight coverage.
- Review ledger validation and PR prerequisite validation completed before push.

## Review

- The inherited plan review recorded four concerns, all resolved, with minor
  divergence.
- Code review round 1 found one vacuous applicability assertion.
- The assertion was fixed and code review round 2 returned clean.

## Blockers

None.

# Floor 2 win-condition pipeline coverage

**Date:** 2026-09-09

**Estimate:** 4 apples

**Actual:** 4 apples

**Verdict:** recommended — the existing evaluator and shared completion latch already
matched the canonical contract; the missing assurance was an independent Win A
real-pipeline regression case.

## Systems touched

quests, ai-pathfinding

## Summary

Audited the canonical Floor 2 win shapes against `floor2ObjectiveTick`,
`floor2VictorySystem`, the Floor 2 scenario definition, and the shared simulation
pipeline. Added unit coverage for the empty-roster guard and an integration
regression that drives Win A at relation 76 through
`createFloorMainSceneOptions('floor2')` and `runSimulationStep`.

The integration case also proves that Win A and Win B share the same resource-heart
stair/leave-floor quest lifecycle, that repeated objective ticks do not recreate
the stairs, and that stair confirmation is idempotent. The canonical evaluator
continues to reject relation 75, multiple living friendly families, and
non-canonical completion outcomes.

## Verification

- `npx vitest run tests/unit/floor2-victory-system.test.ts tests/integration/floor2-victory-pipeline.test.ts --reporter=dot`
- `bash scripts/agent/verify-fast.sh`

## Observation

The real deterministic Floor 2 pipeline now has explicit coverage for the
previously unproven Win A path: relation 76 latches `floor2-victory`, spawns the
resource-heart stairs once, completes the leave-floor quest after confirmation,
and rejects a second confirmation.

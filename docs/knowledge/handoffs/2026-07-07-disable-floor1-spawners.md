# Session Handoff: Disable Floor 1 spawner-system spawning

## Date

2026-07-07

## Persona

Producer

## Systems touched

enemies, ai-combat-balance

## Apples

Estimated: 🍎 x 1
Actual: 🍎 x 1
Verdict: 🎯 exact

## Summary

Disabled `spawnerSystem` execution on Floor 1 in both runtime pipelines while keeping the system wired for non-Floor-1 floors.

## Files touched

- `/home/runner/work/Crawler/Crawler/src/bootstrap/floor-main-scene-options.ts`
- `/home/runner/work/Crawler/Crawler/src/game/ai/simulation-step.ts`
- `/home/runner/work/Crawler/Crawler/tests/game/floor1-main-scene-options.test.ts`
- `/home/runner/work/Crawler/Crawler/tests/integration/floor1-spawners-pipeline.test.ts`
- `/home/runner/work/Crawler/Crawler/docs/knowledge/review-ledgers/2026-07-07-disable-floor1-spawners.review-ledger.json`

## Verification run

- `npm run verify:fast` ✅
- `npx vitest run tests/integration/floor1-spawners-pipeline.test.ts tests/game/floor1-main-scene-options.test.ts` ✅
- `npm run verify` ⚠️ fails only at `verify:pr-prereqs` for missing session artifacts before they were added; code/test gates passed.
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-07-disable-floor1-spawners.review-ledger.json` ✅

## Unresolved issues

- `parallel_validation` reported one unrelated review comment on `scripts/agent/perf/winrate-sweep.ts` not touched by this task.

## Recommended next steps

- When `spawnerSystem` is fixed, restore Floor 1 wiring in both visual + headless pipelines and update the Floor 1 spawner integration guard expectations back to active spawning.

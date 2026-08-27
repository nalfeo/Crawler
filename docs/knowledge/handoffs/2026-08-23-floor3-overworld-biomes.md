# Floor 3 overworld biomes

## Systems touched

mapgen, enemies, ai-behavior-tree, ci-policy

## Summary

- Added Floor 3's seven-biome cave-overworld generation and affinity-weighted wild spawn director.
- Wired wild spawns and the Floor 3 objective tick into the shared scenario pipeline, with a lab for biome and spawn inspection.
- Recovered review findings: timeout expiry now selects Floor 3 timeout presentation and headless `RunStats` classification, and the lab advances one spawn interval per requested burst.
- Kept Slice 7 marked under review until the PR merges; completed and validated its 3🍎 review ledger.

## Validation

- `npx vitest run tests/unit/floor3-overworld.test.ts tests/unit/game-over-classifier.test.ts tests/unit/scenario-definitions.test.ts` passed (33 tests).
- `npm run typecheck`, `npm run lint -- --quiet`, `npm run format:check`, and `npm run check:test-only-exports` passed.
- Before recovery, Floor 3's objective tick set `game_over` but presentation and headless classification treated it as a death; after recovery, the timer goal produces `failed_timeout` presentation and headless `timeout` telemetry.

## Apples

3🍎 estimated, 3🍎 actual (exact).

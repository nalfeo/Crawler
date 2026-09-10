# Floor 6 tower UI request path

## Systems touched

scenario-presentation, floor6-scenario, main-game-scene, floor6-tests

## Verdict and estimate

Recommended. Estimated complexity: 4 apples. The existing Floor 6 transaction was
authoritative and deterministic; the missing piece was the renderer request path.

## Change

Added an optional renderer-neutral construction contract to the scenario
presentation seam. Floor 6 supplies authored site bounds, tower affordability,
and the existing `buildFloor6Tower` transaction. `MainGameScene` now accepts
mouse and touch taps on authored sites, presents an affordable tower picker, and
reports occupied, unaffordable, invalid, phase-locked, and transaction results
without owning economy or occupancy state.

## Observation

Before the fix, `MainGameScene` had no construction callback or pointer path to
`buildFloor6Tower`; only direct unit/headless callers could build towers. After
the fix, the real scene booted through the Floor 6 scenario contract and the
Floor 6 HUD E2E suite passed at 1280x720 and 960x540. Focused unit coverage
also exercised the scene contract's accepted build and atomic occupied rejection;
the headless request suite continued to pass through the same authoritative
transaction.

## Verification

- `npm run typecheck`
- `npm run lint -- --quiet`
- `npx vitest run tests/unit/floor6-towers.test.ts tests/headless/floor6-economy-obs.test.ts`
- `bash scripts/agent/verify-fast.sh`
- `npm run test:e2e -- tests/e2e/main-game-scene-floor6-scenario-hud.test.ts`

# Handoff: Blood pool variance + enemy-size scaling

## Date

2026-07-23

## Persona

Graphics Designer

## Systems touched

vfx, enemies

## Apples

Estimated: 🍎🍎  
Actual: 🍎🍎

## Summary

- Increased deterministic blood-pool silhouette variance in the authoritative blood-surface model by:
  - varying lobe count per pool,
  - widening lobe radius/offset jitter,
  - biasing lobe offsets along a dominant axis for less oval symmetry,
  - widening per-lobe spread timing (`growAt`) and non-core initial scales.
- Added enemy-size-aware initial pool scaling in `createBloodPoolSurface`.
- Wired `dropSystem` to pass each slain enemy's body size (from ECS `Size`) into pool creation.
- Added focused tests for size scaling and variance behavior.

## Files touched

- `/home/runner/work/Crawler/Crawler/src/shared/blood-surfaces.ts`
- `/home/runner/work/Crawler/Crawler/src/core/systems/dropSystem.ts`
- `/home/runner/work/Crawler/Crawler/tests/unit/blood-surfaces.test.ts`
- `/home/runner/work/Crawler/Crawler/tests/ecs/drop-system.test.ts`

## Before/After shape-profile measurements

The following metrics were captured by running the deterministic unit tests against a
fixed sample of 20 pools (seed 42, pool IDs 1–20). They serve as the required
before/after observation record per AGENTS.md rule #9.

| Metric | Before | After (measured) |
|---|---|---|
| Lobe count | Always **5** (fixed constant) | **5, 6, 7, 8** — 4 distinct values across 20 pools |
| Max growth-timing spread per pool | ≤ 0.45 (range `[0.55, 1.00]`) | **0.697** (range `[0.30, 1.00]`) |
| Non-core lobe initial scale | Always **0** — lobes invisible until core done | **0.009 – 0.179** — partial shapes visible from the start |
| Dominant-axis bias | None — offsets uniformly distributed | Per-pool dominant angle biases lobe clustering |
| Enemy-size scaling | Not present — all pools same base radius | Scales by `enemySizeFt / 2.0`, bounded `[0.65 × , 1.85 ×]` |

All three regression tests in `tests/unit/blood-surfaces.test.ts` under
`describe('shape variance profile (before/after evidence)')` assert these thresholds
deterministically (10 tests pass).

## Verification

- `vitest run --project unit tests/unit/blood-surfaces.test.ts` → **10/10 tests pass**
- `vitest run --project ecs tests/ecs/drop-system.test.ts` → passes (enemy-size wiring)
- `npm run verify:fast` — typecheck + lint pass after rebasing onto main

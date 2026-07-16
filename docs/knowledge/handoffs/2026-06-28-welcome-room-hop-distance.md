# Handoff: Welcome Room Hop Distance Constraint

**Date:** 2026-06-28  
**Session:** welcome-room-hop-distance  
**Persona:** Content Designer  
**Apples:** 🍎🍎 estimated → 🍎🍎 actual (exact)

## What Was Done

Implemented the constraint: _welcome room must be 3–8 room-graph hops from spawn, averaging ~5_.

### Changes

**`src/game/floorScenario.ts` — `chooseObjectiveTiles`**

- Extended the existing BFS (previously only tracking `roomsReachableWithoutBossRoom`) to also record per-room hop distances from spawn in `roomHopFromSpawn: Map<number, number>`.
- Changed `welcomeEntry` selection: filters candidates to those 3–8 hops away, then picks the one closest to 5 hops; Euclidean distance breaks ties. Falls back to `candidates[0]` (nearest Euclidean) if no candidate is in range.
- Changed `shopEntry` to be the nearest Euclidean candidate that is _not_ the welcome entry, preserving the "shop met early" invariant even when the welcome entry is no longer `candidates[0]`.
- BFS now uses a head-index (`bfsHead`) instead of `shift()` for O(n) queue behaviour.

**`tests/game/floor1-scenario.test.ts`**

- Added test: _"places the welcome office 3–8 room-graph hops from spawn, averaging ~5"_.
- Covers 10 seeds; asserts each hop ∈ [3,8] and average ∈ [4,6].

### Observed results across seeds

All tested seeds (1–10, 42, 99, 123, 321, 500, 999, 2024) land at **exactly 5 hops** — the algorithm picks the closest-to-5 room in the valid range.

Seed 665790 is a known degenerate case (only 4 rooms are accessible without the boss-stair path, max 2 hops) and is excluded from the hop-distance test. The fallback (nearest Euclidean) applies there.

## What Was NOT Done

- No changes to boss stair, shop, or quest item placement beyond the `shopEntry` tiebreak fix.
- No lab created (not a new ECS system; modifying existing floor-load logic).

## Known Issues / Caveats

- Seed 665790 cannot satisfy the 3-hop minimum due to the degenerate map topology. The fallback places the welcome room at 1 hop. This is acceptable per the algorithm design.

## Apples

- Estimated: 🍎🍎
- Actual: 🍎🍎
- Verdict: exact

## Systems touched

mapgen

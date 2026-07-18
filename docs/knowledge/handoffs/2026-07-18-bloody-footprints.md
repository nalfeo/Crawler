# Session Handoff: Bloody footprints

## Date

2026-07-18

## Persona

Producer (single-session gameplay/rendering implementation with review-harness loops and no child slices).

## Systems touched

vfx, enemies, devtools

## Apples

4🍎 estimated → 4🍎 actual (exact). Full JSON: `docs/knowledge/metrics/apples/2026-07-18-bloody-footprints.json`.

## What Was Done

Implemented issue #1267 end to end with a single authoritative blood-surface model in ECS/state instead of renderer-owned pool state.

- Added `src/shared/blood-surfaces.ts` for deterministic blood-pool / footprint geometry, lifetimes, color mixing, and contact helpers.
- Extended `GameWorld` with authoritative `bloodPools`, `bloodyFootprints`, and `bloodyFootprintState`.
- Added and wired `src/core/systems/bloodyFootprintSystem.ts` into `runCoreSimulationStep()` so the real runtime/headless pipeline now:
  - activates or refreshes a ~5s bloody-footprint source while the player is in visible blood,
  - mixes colors when a new-colored pool is contacted during the active window,
  - emits persistent ~5s footprints/smears while moving,
  - snaps the source trail forward on large teleports/floor jumps instead of backfilling across the map.
- Moved persistent pool authorship into `dropSystem`, so enemy deaths create authoritative pools in world state.
- Refactored `GoreVfx` to render `world.bloodPools` and `PlayerTrailVfx` to render `world.bloodyFootprints`, while preserving the ECS/Phaser boundary (core owns state, engine only draws it).
- Added `bloody-footprints-lab` and extended `main-scene-probe-lab` with deterministic pool seeding / frame-advance / blood-surface summary APIs.
- Added/updated coverage in:
  - `tests/unit/blood-surfaces.test.ts`
  - `tests/ecs/bloody-footprint-system.test.ts`
  - `tests/integration/bloody-footprint-pipeline.test.ts`
  - `tests/e2e/bloody-footprints-main-scene.test.ts`
  - supporting render tests in `tests/unit/vfx-world-coords.test.ts`, `tests/ecs/drop-system.test.ts`, and the Phaser harness.

## Runtime / Visual Evidence

Observed in the **real `MainGameScene` runtime** through `main-scene-probe-lab`, not just the new lab sandbox.

- **Before:** `getBloodSurfaceSummary()` reported `poolCount=0`, `footprintCount=0`, `renderedPoolCount=0`, `renderedFootprintCount=0`, `activeSourceColor=null`. Screenshot: `files/bloody-footprints-before.png`.
- **After deterministic probe sequence** (seed red pool under player, walk two steps, seed blue pool, walk one more step): `poolCount=2`, `footprintCount=5`, `renderedPoolCount=2`, `renderedFootprintCount=5`, `activeSourceColor=8399718 (0x802b66 mixed)`, and `footprintColors=[13369344,13369344,13369344,8399718,8399718]`. Screenshot: `files/bloody-footprints-after.png`.

This proves the shipped runtime, not a lab-only harness, now renders pools plus mixed-color bloody footprints and keeps the renderer in sync with authoritative sim state.

## Key Decisions Made

- **Single-source-of-truth blood surfaces:** persistent pools and footprints live in `GameWorld`; engine VFX only mirrors them.
- **Visible-geometry contact, not oversized radius contact:** pool overlap now uses the age-scaled rendered lobe geometry so the player only becomes bloody when touching visible blood.
- **Death-point anchoring:** authoritative pools stay anchored to the true death point so immediate kill-site contact remains reliable even though pool growth is gradual.
- **Stride-aware smears:** footprint smear intensity now keys off the original stride distance for the frame, not the fixed 0.42-ft slice size, so faster movement produces stronger smears.

## What's Next / Blockers

No known blockers. Remaining work is PR hygiene / CI merge flow only.

## Retrospective

### Lessons Learned

- The review harness caught real issues here: the first multi-model pass surfaced four valid bugs, a later pass found the kill-site contact regression, and a final pass caught smear intensity being accidentally flattened by fixed-size segmentation.
- The real-scene probe seam is strong for gameplay/rendering work: exposing deterministic frame stepping plus authoritative state summaries let the runtime evidence stay reproducible without adding one-off debug hooks to production code.

### Mistakes Made

- I initially let the renderer-jittered pool center participate in first-contact logic; that made kill-site pickup unreliable in the integration test until the pool origin was re-anchored to the actual death point.

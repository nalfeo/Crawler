# 2026-07-30 — Wall inset against rock + revealing and lighting room corners

## Summary

Fixed three Floor 1 terrain/lighting defects (3🍎). Two further reported
symptoms — per-side apron blending and door sizing/art — are out of scope and
tracked as follow-up PRs.

1. **Wall inset bled floor into rock and map edges.** Authored terrain-pack
   walls inset away from any cardinal neighbour whose terrain didn't literally
   equal a wall type, including `TerrainType.VOID` (solid rock) and
   out-of-bounds neighbours. This stamped the pack's floor pool in the inset
   sliver, leaking lit room floor into what should read as solid rock.
2. **Room interior corners were never revealed.** The corner-seam rule — which
   exists to stop a ray squeezing _through_ a diagonal gap between two walls —
   was also applied to the tile a ray _terminates on_. A room's interior corner
   is diagonal from the player with both orthogonal wall runs opaque, so it
   always failed the check and stayed black while the walls beside it lit up.
3. **Revealed corners were still not lit.** Fixing FOV alone was not enough:
   `src/engine/lighting/light-field.ts` gates source illumination on
   `map.hasLineOfSight(...)`, which reaches `TileMap.lineOfSight` through the
   `FloorMap` wrapper and had the same misapplied seam rule. The corner passed
   the visibility gate and was then rejected for illumination, falling back to
   `ambient`.

See `docs/knowledge/adr/0079-wall-inset-non-walkable-neighbours-and-fov-corner-terminal-exemption.md`
for the design rationale and the rejected alternatives.

## The fix

Defects 2 and 3 collapse into **one shared rule**. `hasBlockedCornerSeam` and
`lineOfSight` (`src/core/map/TileMap.ts`) both hoist
`const targetOpaque = !this.isTransparent(x1, y1)` and, after each step, break
on `reachedTarget && targetOpaque` **before** the seam check. Only the seam
formed by the final step into an opaque target is exempted; every earlier seam
still applies. `fovSystem.ts` runs the seam check for every tile again.

The exemption keys off the **target**, never the origin — exempting an opaque
origin would let a wall-mounted light source leak through diagonal gaps.

## Files touched

- `src/core/map/TileMap.ts` — terminal-step exemption in both
  `hasBlockedCornerSeam` and `lineOfSight`; corrected the stale "LOS is
  symmetric" doc claim (it is asymmetric when exactly one endpoint is opaque).
- `src/core/systems/fovSystem.ts` — seam check runs for every tile, then the
  opaque whole-tile fill.
- `src/shared/terrain-pack-mask.ts` — `computeRawMask8` gained
  `outOfBoundsMatches` (default `false`, existing callers unchanged); wall-mask
  callers pass `true` so an edge wall full-bleeds.
- `src/engine/terrain-renderer.ts` — `PACK_WALL_MASK_NEIGHBOR_TERRAIN_TYPES`
  extended with `VOID` and `WOOD_WALL`. `WATER`/`LAVA` excluded (visible-through,
  so insetting toward them is correct); `TREE` excluded (a trunk neither fills
  its cell nor reads as a wall face, and nothing writes it).
- `src/labs/terrain-pack-lab/index.ts` — mirrors the renderer's argument so lab
  and game never drift on this predicate.
- `src/labs/ai-runner-lab/scenario-presets.ts` — `TERRAIN_JUNCTION_SLICE` gained
  a VOID-bordered wall run and a VOID pocket.
- Tests: `tests/ecs/tilemap.test.ts` (3 LOS gates), `tests/ecs/fov-system.test.ts`
  (leak gate + four-corner gate), `tests/ecs/fov-system-equivalence.test.ts`
  (reference realigned seam-first), `tests/unit/terrain-pack-renderer.test.ts`,
  `tests/unit/terrain-pack-floor1-biomes.test.ts`,
  `tests/unit/ai-runner-scenario-presets-wiring.test.ts`.

No atlas regeneration needed — this only changes which existing blob47 frame is
selected, and every pack is schema-validated to carry all 47 canonical masks.

## Verification

- `npm run verify:fast` — passed.
- `npm run test:headless` — **176/176**, including Floor-1 win-rate,
  determinism and park-watchdog. FOV feeds AI perception, so this was the real
  regression risk.
- **Anti-tautology check**: neutralising `targetOpaque` fails 3 tests (including
  the pre-existing four-corner gate); restoring the old opaque bypass fails the
  leak gate. The gates genuinely detect the bugs.
- Review ledger validated at 3🍎 with `plan_review` + `code_review`.

### Observe before done — real running scene, quantified

In `/lab.html?lab=ai-runner&scenario=terrain-wall-junctions`, every interior room
corner was enumerated from the live `TileMap` and evaluated against both the
pre-fix and post-fix `lineOfSight`:

|        | corners | dark (ambient only) |
| ------ | ------- | ------------------- |
| before | 10      | **10**              |
| after  | 10      | **0**               |

All 10 went from ambient-only to source-lit — the exact reported symptom.

## Lessons worth keeping

- **Resolve consumers through wrapper names, not just the symbol.**
  `light-field.ts` calls `map.hasLineOfSight(...)`, so grepping it for
  `lineOfSight` returns **nothing**. This caused a code review to return a false
  "clean" verdict (concluding no consumer treats an opaque tile as an LOS
  endpoint) and nearly caused the same mistake during adjudication. The wrapper
  is `FloorMap.hasLineOfSight` → `TileMap.lineOfSight`.
- **A "clean" review is evidence, not proof.** Here the plan review and the code
  review directly contradicted each other. Checking the decisive fact in source
  resolved it; on challenge, the code review withdrew its clean verdict. When two
  reviews disagree, verify rather than picking one.
- **Fixing a symptom's first half can look done.** Revealing the corner made it
  appear in FOV while leaving it visually dark — the user's actual complaint.
  Trace the symptom to the pixel, not to the first system that explains it.
- **Concurrent sessions must not share a worktree.** A delegated child session
  restarted and repeatedly reverted edits in the shared worktree. Worktrees share
  the git object store, so the reliable recovery is
  `git reset --hard <sha>` into your own worktree, then push from there. Treat a
  session with a live `active_session_id` as actively writing.

## Recommended next steps

- PR 2: per-side apron underdraw blending, so each apron sliver draws the pack it
  faces and inherits the facing cell's visibility. Investigate whether FOV
  `subFactor` 2 is too coarse for an 18.75% apron.
- PR 3: door sizing — clamp width to the cell in both orientations, pin the
  bottom to the tile edge, overflow only northward, and retire the rotation path
  in favour of genuine side-on E/W art.

## Systems touched

mapgen, lighting, devtools

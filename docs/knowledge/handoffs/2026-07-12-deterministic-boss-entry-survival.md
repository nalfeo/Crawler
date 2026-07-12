# Session Handoff: Deterministic Boss-Entry Survival

## Date

2026-07-12

## Persona

Producer -> Game Designer -> QA Engineer

## Systems touched

mapgen, boss-rooms, ai-behavior-tree, ai-combat-balance

## Apples

4🍎 estimated, 4🍎 actual

## What Was Done

- Proved the representative Floor 1 failures were not final-stair travel attrition: the
  player reached lock-in healthy, then died because seed 8's declared 17x17 staircase
  boss room contained only one passable interior tile.
- Added deterministic `BOSS_STAIR` geometry repair in `ensureRoomsReachable()`. It
  guarantees a centered 5x5 passable arena, bounded for smaller rooms, and fixed
  door-to-center paths before connectivity cleanup.
- Replaced center-biased random Floor 1 boss spawning with exhaustive structural
  reachability and maximum-minimum-distance scoring against the live player and every
  declared door. Both Floor 1 bosses use the same selector, with a preferred 8-ft
  minimum and the safest legal deterministic fallback.
- Added a generic hostile-encounter revision. Encounter activation invalidates stale
  transient behavior-tree decisions once, then the normal provider immediately
  observes the spawned threat at the earliest pipeline-safe poll.
- Added direct and property-based coverage proving malformed boss rooms are repaired,
  valid connected boss arenas are byte-identical across varied dimensions, placement
  ignores dynamic barrier overlays without escaping structural reachability, and both
  bosses share the encounter lifecycle.
- Updated deterministic dungeon goldens for the intentional geometry correction.
- Observed in the real headless Floor 1 pipeline: before, all four representative
  configurations died or failed under 360 seconds; after, seed 8 with baseball-bat,
  bow, and pistol plus seed 94 with throwing-knife are all official wins under the
  unchanged 360-second definition, with both bosses defeated and the staircase
  completed.

## Key Decisions Made

- Repair the proven malformed geometry at generation finalization instead of adding a
  boss-specific movement exception or tuning contact damage.
- Use structural tile passability for spawn reachability. Dynamic barriers are not
  connectivity: the player can occupy a temporarily blocked tile, so including barrier
  overlays in the flood origin can crash encounter activation.
- Keep placement RNG-free and deterministic. The removed random draws intentionally
  re-phase the later shared RNG stream; aggregate cloud outcomes, not preservation of
  individual winner identities, are the acceptance signal.
- Make encounter-start repoll a reusable lifecycle invariant rather than branching on
  floor, boss, seed, weapon, or final-stair state.

## What's Next / Blockers

- Run PR prerequisites, commit, and push the reviewed branch.
- Dispatch the canonical 100-seed x 6-weapon GitHub sweep. The branch is blocked from
  PR creation unless all four focused configurations remain official wins and the
  aggregate is at least the 556/600 baseline under the unchanged 360-second limit.
- Open the dedicated PR after the cloud gate passes; do not merge it.

## Retrospective

### Lessons Learned

High aggregate travel efficiency and lock-in deaths can resemble panic steering
failure, but tracing HP and geometry across the encounter boundary separated travel
from activation. Inspecting the reachable component, not only world-space distance,
exposed the one-tile arena immediately.

### Mistakes Made

The first placement-only fix assumed the declared room contained usable arena
geometry. The early signal was that exhaustive placement still returned contact range
and fresh AI repoll did not improve survival. A temporary generic opening-spacing
experiment improved only one of four cases before the final diagnostic proved every
retreat target was unreachable; that behavior was removed rather than retained as a
mask.

### Opportunities for Future Improvement

Map-generation diagnostics could report declared boss-room interior area and reachable
arena dimensions as deterministic metadata. That would make malformed set-piece rooms
visible before a headless combat failure and reduce the need for frame-level captures.

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
  guarantees a 5x5 passable arena window (or the largest bounded interior for
  smaller rooms), choosing the window with the most existing floor and using
  center proximity only as a tiebreaker, plus fixed door-to-center paths before
  connectivity cleanup.
- Reused the same no-op-on-valid repair for the dynamically selected Slime Rat
  encounter room after objective selection and sealing, preserving that room's existing
  floor terrain and accounting for load-bearing doors added by sealing. It chooses the
  5x5 window with the most existing floor and leaves connected L-shaped rooms
  byte-identical.
- Replaced center-biased random Floor 1 boss spawning with exhaustive structural
  reachability and maximum-minimum-distance scoring against the live player and every
  declared door. Both Floor 1 bosses use the same selector, with a preferred 8-ft
  minimum and the safest legal deterministic fallback.
- Added a generic hostile-encounter revision. Encounter activation invalidates stale
  transient behavior-tree decisions once, then the normal provider immediately
  observes the spawned threat at the earliest pipeline-safe poll.
- Added direct and property-based coverage proving malformed boss rooms are repaired,
  valid connected boss arenas are byte-identical across varied dimensions, placement
  ignores dynamic barrier overlays without escaping structural reachability, occupied
  passable perimeter entries and declared doorways remain valid sealed-room flood origins,
  and both bosses share the encounter lifecycle.
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
- Treat the player's occupied passable perimeter entry or declared doorway as a virtual
  flood origin when the selector is called directly. It is never a boss candidate, and
  every other declared doorway remains sealed for traversal.
- Require RoomGraph ownership—not rectangular bounds—for both Floor 1 boss activation
  predicates. This prevents irregular-room bounding boxes from starting lock-in while
  the player is on a disconnected tile.
- Keep placement RNG-free and deterministic. The removed random draws intentionally
  re-phase the later shared RNG stream; aggregate cloud outcomes, not preservation of
  individual winner identities, are the acceptance signal.
- Make encounter-start repoll a reusable lifecycle invariant rather than branching on
  floor, boss, seed, weapon, or final-stair state.

## Cloud validation

- The first canonical cloud sweep preserved all four focused wins but scored 543/600;
  seeds 7 and 69 produced the same placement-origin exception across all six weapons.
  The second sweep scored 546/600; seeds 12 and 25 exposed the deeper trigger defect:
  irregular-room bounds included passable tiles disconnected from RoomGraph-owned
  interior. Generic origin handling plus exact room-owned activation and real-headless
  regressions now cover both boundaries.
- The maintainer explicitly replaced the prior `>=556/600` aggregate requirement with
  a focused cloud gate. The exact target set combines the previously failing geometry
  seeds 7, 12, 25, and 69 across all six weapons with the original controls: seed 8
  using baseball-bat, bow, and pistol, plus seed 94 using throwing-knife.
- Runs `29226968319`, `29227705981`, and `29227710372` produced 28/28 official wins
  with zero deaths, stalls, timeouts, or errors. Maximum completion time was 323.65
  seconds under the unchanged 360-second budget. The earlier broad shards remain
  cancelled.

## What's Next / Blockers

- No implementation or validation blocker remains. Open the dedicated PR and do not
  merge it.

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
mask. The first post-sweep crash fix assumed the rejected origin was a declared door;
the direct real-headless reproduction showed it was instead a passable perimeter tile
accepted by the encounter bounds predicate but omitted from RoomGraph interior ownership.

### Opportunities for Future Improvement

Map-generation diagnostics could report declared boss-room interior area and reachable
arena dimensions as deterministic metadata. That would make malformed set-piece rooms
visible before a headless combat failure and reduce the need for frame-level captures.

# Session Handoff: Floor 1 cornered-retreat wedge deadlock (release-sweep seed 25)

## Date

2026-08-15

## Persona

Game AI Engineer

## Systems touched

ai-combat-balance, ai-pathfinding

## Apples

2🍎 exact

## What Was Done

Fixed the Floor 1 release-sweep loss reported in #2993
(`floor1|forceWeapon=true|damage=1|seed=25|weapon=throwing-knife`).

Reproduced deterministically with `npm run ai:headless -- --seed 25 --weapon
throwing-knife --floor floor1` (real headless pipeline, not a lab). Before:
`Outcome: DEATH` at frame 6410. A per-poll probe over the real runner showed the
player pinned at exactly `(96.02, 40.01)` — tile `(24,10)`, a room corner with
wall on both the `-x` and `-y` side — for ~500 frames in `RETREAT`, pushing at
full throttle (`moveX≈-0.83, moveY≈-0.56`) while collision cancelled both axes
and contact damage took it from 67% HP to 0.

Root cause: `pickRetreatTarget` scans a ±120° arc away from the swarm centroid
and A\*-verifies candidates. In that corner every candidate was wall, so it fell
through to the naive away-from-threat vector — which points _into_ the corner
the player is already pressed against.

Fix: when a retreat is measurably _wedged_ (a full re-pick interval elapsed with
< 1 ft of net movement, versus ~6-7 ft of normal travel), widen the escape scan
to the remaining rearward directions (±150°, 180°). After: seed 25 is
`Outcome: VICTORY`, and seed 39 (the #2992 boss-contact regression seed) still
wins.

## Key Decisions Made

- **Gate the widened scan on a measured wedge, not on "the arc scan failed".**
  An unconditional breakout arc also fixed seed 25 but perturbed every retreat
  lane in every run and flipped seed 39 to a loss. Requiring zero net movement
  across a re-pick interval keeps all retreats that are actually travelling
  byte-identical, so the blast radius is exactly the deadlock being fixed.
- **Rejected: narrowing the #2992 contact carve-out to `criticallyLow`.** It
  fixed seed 25 but re-broke seed 39 — that carve-out is not the defect; the
  cornered-retreat fallback is.
- **Rejected: reverting #2992.** That restores the seed-39 boss-contact death.

## What's Next / Blockers

None blocking. Broader follow-up worth considering: a retreat that runs for
hundreds of frames inside a spawner arena still bleeds out slowly because there
is no floor healing — a "retreat is not recovering HP" watchdog that hands the
fight back to Engage (or leaves the room outright) would likely convert several
of the remaining slow-loss shapes.

## Retrospective

### Lessons Learned

- The runner's event log (`--event-log`) shows state/reason/position but not the
  emitted move vector; a `BehaviorTreeAI` subclass overriding `poll()` and
  logging `state.moveX/moveY` plus a tile-passability dump around the player is
  the fastest way to tell "AI issues no input" from "AI is blocked by geometry".
  Here the AI _was_ at full throttle — the position was frozen by collision.
- Floor 1 seeds are chaotically sensitive: any behavior change that fires on a
  common code path re-rolls unrelated seeds. Prefer fixes whose trigger
  condition provably cannot occur on healthy runs.

### Mistakes Made

- First attempt scoped the fix to the #2992 retreat carve-out (`criticallyLow`)
  on the theory that seed 25 was a bad _retreat entry_. Early signal that this
  was wrong: the probe showed the retreat's chosen target was exactly
  `scanRadius` away from the player, i.e. the naive fallback — the entry
  condition was fine, the _destination_ was unreachable.
- Second attempt applied the breakout arc unconditionally and flipped seed 39.
  Early signal: it changed the retreat target on runs that were never wedged.

### Opportunities for Future Improvement

- `RETREAT` is the only major AI state without a progress watchdog (ENGAGE,
  COLLECT, EXPLORE, global dwell and quest progress all have one). A generic
  "retreat made no progress / lost HP without breaking contact" watchdog would
  cover this class of deadlock structurally instead of per-shape.
- The headless CLI could optionally include the emitted move vector in `sample`
  events; every wedge/park investigation currently re-derives it by hand.

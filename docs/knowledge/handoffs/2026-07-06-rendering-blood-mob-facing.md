# Session Handoff: Fix rendering depth, blood-pool spread, and mob facing

## Date

2026-07-06

## Persona

Producer → Renderer/VFX Engineer

## Systems touched

vfx, enemies, hud-ux

## Apples

2🍎 estimated (three small-scope surgical fixes across depth, VFX, and fallback textures)

## What Was Done

Three player-facing bugs fixed together:

1. **Player rendered underneath blood pools and corpses.** Entities inherit
   Phaser's default depth of 0 while `WORLD_VFX_DEPTH.bloodPool` was `5`, so
   fresh kills painted ON TOP of the player. Corpses (same img at depth 0) also
   drew on the player thanks to add-order tie-breaking. Fix: pushed
   `bloodPool` to `-18`, added `corpse: -17`, moved `playerTrail` to `-16`, and
   set `img.setDepth(WORLD_VFX_DEPTH.corpse)` on decaying corpses in
   `PhaserBridge.ts` (with a symmetric `setDepth(0)` in the EID-recycle branch
   so a resurrected sprite doesn't linger on the corpse plane).
2. **Blood pools spread evenly and stopped growing after ~3.6 s of their 30 s
   life.** `spawnBloodPool` used a single `Phaser.GameObjects.Ellipse` scaled
   uniformly, and `BLOOD_POOL_EXPAND_PHASE` was `0.12`. Rewrote it as a
   `Phaser.GameObjects.Graphics` with `BLOOD_POOL_LOBE_COUNT = 5` overlapping
   sub-lobes at randomised offsets, each with its own `growAt` so the outline
   is visibly irregular AND keeps creeping outward. Raised
   `BLOOD_POOL_EXPAND_PHASE` to `0.7` — pools now spread across most of their
   lifetime.
3. **Mobs faced the opposite direction of their motion.** Root-cause: the
   procedural fallback `TEX_ENEMY_RAT` was authored LEFT-facing (head circle
   at x=6, tail whip at x=18-22 in a 24-wide texture), but the flip logic
   assumes right-facing native art per the sprite-pipeline contract
   (`data/sprite-types/enemy.json` sets `sensors.enemy.facing: "right"`). Fixed
   by flipping the fallback rat (head → x=18, tail → x=2-6) and boss (slime
   tail triangle → left half). Left `img.setFlipX(!movingRight)` unchanged —
   the flip logic was correct; the fallback textures were the bug.

Runtime observation not performed (this is a cloud-backed session with local
file access; `npm run dev` requires a display and wasn't available in this
environment). Instead, the fixes are backed by targeted deterministic tests
(see below) that pin the observable behaviour.

## Key Decisions Made

- **Fix the fallback textures, not the flip logic.** Two options for bug #3
  were: (a) invert the code to `flipX(movingRight)` to match the LEFT-facing
  fallback, or (b) flip the fallback textures to face right and leave the
  flip logic alone. Chose (b) because the sprite-pipeline metadata already
  codifies right-facing as the contract, generated PNG assets already face
  right, and (a) would put the code out of sync with the pipeline for every
  future generated enemy. See the extensive comment at
  `PhaserBridge.ts:957-968` for the pre-existing rationale.
- **Blood pool as `Graphics`, not multiple ellipses.** Multiple stacked
  `Phaser.GameObjects.Ellipse` instances would multiply the display-object
  count by 5 per pool (up to 750 with `MAX_BLOOD_POOLS = 150`). A single
  `Graphics` per pool with a per-frame redraw is cheap (a few `fillEllipse`
  calls) and keeps the object-count bounded.
- **Per-lobe `growAt` progress driver, not `sizeScale`.** First implementation
  used `sizeScale` (0.25 → 1.0) divided by `growAt` (0.35 for the core lobe)
  which gave an initial `lobeProgress` of 0.71 — the pool visually stopped
  growing after the first few frames. Corrected to drive growth off
  `expandProgress = min(1, progress / EXPAND_PHASE)` so `lobeProgress` starts
  at 0 and grows monotonically. Caught by the "keeps spreading past 5 s"
  regression test on the first run.
- **`playerTrail` moved from depth 6 to depth −16.** Even though the user
  didn't call it out, the previous ordering had trail dust rendering ABOVE
  the player (dust puffs floating in front of the walking sprite). Fixing it
  as part of the ground-plane depth refactor keeps the pool < corpse < trail
  ordering intact and puts the player and other entities on top of every
  ground effect.

## What's Next / Blockers

- **Runtime observation** (rule #10) still owed. If the game exposes any
  reproducible visual capture (`tests/e2e/helpers/pixels.ts` or
  `tests/headless/*`), promote the fallback-facing regression into that gate.
- **Generated-sprite audit.** The fallback-facing bug hid behind the fact
  that generated art _does_ face right; the fallback bug only surfaced when
  the game rendered without generated PNGs available. Worth a quick audit of
  every procedural `TEX_ENEMY_*` texture (there are several — slime is
  currently bilateral, but future enemies may not be) with the same "head
  belongs on the right half" invariant, ideally promoted into the
  `procedural-fallback-facing.test.ts` regression net.
- **Blood-pool visual polish.** The 5-lobe pool reads as organic in
  simulation, but a lab pass would be worth doing to tune the lobe count,
  offset radius, and growth timings.

## Retrospective

### Lessons Learned

- **Read the comment**. `PhaserBridge.ts:957-968` explicitly states the
  right-facing native convention and warns future readers to revisit the
  pipeline contract together with the flip logic rather than making a
  one-line inversion. This comment was pure gold — it correctly directed the
  investigation away from the flip line and toward the texture pipeline.
- **Trust the user's live report over your own image reading.** I initially
  looked at the `rat-v1-var-9.png` PNG and reported it as LEFT-facing. The
  user corrected me ("it looks like it's pointing to the right"), and their
  read was correct — I'd misread which end was the nose vs the tail. Live
  human eyes on running game > my parse of an upscaled PNG.
- **Growth math needs a first-frame trace, not just an end-frame trace.**
  The initial `sizeScale / growAt` design failed at t=0 (lobeProgress = 0.71
  because `sizeScale = 0.25` and `growAt = 0.35`) — the pool started ~70%
  grown. Verifying only the end state (final size) would have missed this.
  The "at least 1.5× at 5 s" and "still growing at 15 s" test caught it
  because it forced a comparison of TWO points in time, not just one.

### Mistakes Made

- **Initial image misread.** Told the user the generated rat sprite looked
  left-facing after upscaling `rat-v1-var-9.png`. Recovered when the user
  contradicted me. Lesson: when disagreeing with the user about something
  they've seen live, err toward "I misread the pixels" rather than "the
  asset is authored wrong".
- **First blood-pool growth math bug.** Divided `sizeScale` by `growAt`
  instead of `expandProgress` by `growAt`, which made the core lobe already
  71 % grown at spawn. Caught by the new regression test on the very first
  run, so it didn't ship, but a more careful hand-trace of `t=0` would have
  found it before I wrote the test.

### Opportunities for Future Improvement

- Fold **ordering invariants** into `render-depths.ts` as a small `describe`
  test that asserts `bloodPool < corpse < playerTrail < 0 < gore` etc.
  Currently the ordering is implicit in the constants; a broken sort order
  would silently reintroduce the "player under blood" class of bug.
- Consider a **directional-authoring lint** for procedural textures — a
  simple test that all `TEX_ENEMY_*` fallbacks have more drawing-command
  centroid mass on the right half than the left half, so future fallbacks
  can't accidentally regress the facing contract.
- The pool object count could still spike to `MAX_BLOOD_POOLS = 150` in
  extreme combats. Each pool is now a `Graphics` with a per-frame redraw of
  5 ellipses (750 `fillEllipse` calls per frame at cap); still cheap, but a
  future optimisation could bake pools to a texture once they finish
  expanding so the last ~9 s of each pool's life is a static image blit.

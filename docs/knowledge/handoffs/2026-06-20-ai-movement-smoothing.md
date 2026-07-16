# Handoff — AI runner movement smoothing

**Date:** 2026-06-20  
**Branch / PR:** current working branch  
**Persona:** Game Designer  
**Apple estimate:** 🍎 (1) · **Actual:** 🍎 (1) · verdict **exact**

## Systems touched

ai-pathfinding

## Goal

Eliminate the visual jerkiness in the AI runner's movement. The player character
was snapping to new directions instantly at each A\* waypoint and kite reversal,
producing harsh 90° heading snaps at ~8 px intervals.

## Root cause

`BehaviorTreeAI.poll()` sets `state.moveX/moveY` to a unit-length direction
vector every frame with no temporal blending. `playerInputSystem` then sets
`velocity = direction × speed` unconditionally — zero latency, zero
acceleration. On a tile grid with 8 px tiles and 3 px/frame player speed
(~2.7 frames per tile), direction changes happened every 2–3 frames, far too
fast to read as intentional motion.

## Fix

Added exponential output-direction smoothing to `BehaviorTreeAI` in
`src/game/ai/bt-ai-provider.ts`:

- **`MOVE_SMOOTH_FACTOR = 0.5`** — per-frame blend fraction (new constant).
- **`smoothMoveX / smoothMoveY`** — persistent private fields, initialized to
  `(0, 0)` at construction and never explicitly reset; the blend carries over
  every poll for the lifetime of the AI instance.
- At the end of every `poll()`, after `moveToward()` writes the raw desired
  direction, the two smooth fields exponentially decay toward it:
  ```
  smoothMoveX += (rawMoveX - smoothMoveX) * MOVE_SMOOTH_FACTOR;
  state.moveX = smoothMoveX;
  ```
  `normalizeInputDirection` in `playerInputSystem` only normalizes vectors with
  length > 1, so sub-unit blended values pass through unchanged — the character
  naturally slows slightly through turns and accelerates out.

With factor 0.5 a full 90° cardinal-direction change completes in ~4–5 frames
(~70 ms at 60 fps), producing a smooth curved arc at waypoints. Straight-line
travel is unaffected (smooth value converges to unit magnitude within ~30 frames
and stays there).

## Verification

- `npx vitest run --project unit` — **1329/1329** (added 1 new smoothing test in
  `tests/game/behavior-tree-ai.test.ts` that verifies first-poll magnitude < 1
  and converges > 0.95 after 30 polls).
- `npm run test:headless` — **4/4** green; seed 42 still clears Floor 1 in
  < 5-minute game-time budget (smoothing adds only a few seconds of extra turn
  overhead, well inside the 134 s margin).
- `npm run typecheck` — clean.

## Open follow-ups

- The `MOVE_SMOOTH_FACTOR` is a single global value; kiting orbits and retreat
  sprints might benefit from slightly different factors. Tunable once visual
  feedback is available in the AI runner lab.
- Sub-frame render interpolation (`interpAlpha` in `PhaserBridge.sync`) is
  implemented but always called with the default `0`. At 60 fps simulation +
  60 fps render the residual accumulator is near zero so this rarely matters,
  but passing `accumulator / GAME.DELTA_MS` would eliminate any remaining
  sub-frame snap if the game ever runs at lower simulation rates.

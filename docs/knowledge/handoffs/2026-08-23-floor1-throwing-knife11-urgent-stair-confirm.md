# Session Handoff: Floor 1 throwing-knife seed 11 release timeout

## Date

2026-08-23

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, ai-pathfinding

## Apples

3🍎 estimated / 3🍎 actual

## What Was Done

- Reproduced the release-leg failure signature in the real headless pipeline options:
  `floor=floor1|forceWeapon=true|damage=1|seed=11|weapon=throwing-knife`.
- Confirmed deterministic timeout at the Floor 1 release frame cap (`FLOOR1_DEFAULT_MAX_FRAMES`): outcome `timeout` at ~660s with `floor1-leave-floor` incomplete.
- Recovered review feedback by moving the widened stair-confirm radius into the
  shared Floor 1 marker contract. `autoFloor1ProgressionSystem` remains gated by
  the same `objective.markerRadiusFt` used by the shipped interaction prompt;
  the Floor 1 manifest now sets that shared marker to 24ft.
- Fixed the underlying final-stair convergence in `BehaviorTreeAI`: once the
  Floor 1 stairs are unlocked and are the current target, close-range movement
  switches to direct local navigation so the AI physically enters the canonical
  marker instead of treating the terminal stair target like a suppressible
  unreachable explore waypoint.
- Added deterministic regression coverage:
  `tests/headless/floor1-throwing-knife11-release-regression.test.ts`, plus a
  parity test proving collapse urgency does not auto-descend from outside
  `objective.markerRadiusFt`.

## Observe before done (real artifact)

- **Before:** direct headless run (`runHeadless` sweep-equivalent settings, forced throwing-knife seed 11, Floor 1 release frame cap) timed out at 660s.
- **After:** same settings now produce deterministic victory within the same frame cap (paired reruns in regression test). A direct post-fix run cleared at frame 32,422 (540.4s) with `floor1-leave-floor` complete. The seed-selected PR gate regression (`seed=11`, baseball-bat) clears at frame 32,400 after the shared marker change.

## Verification Run

- `npm test -- --run tests/headless/floor1-completion.test.ts`
- `npm test -- --run tests/headless/floor1-throwing-knife11-release-regression.test.ts`
- `npm test -- --run tests/game/auto-progression-npc.test.ts`
- GitHub-backed Floor 1 release panel: pending dispatch after repair push.

## Unresolved / Follow-ups

- Publish the repair commit, then dispatch the 50-seed × 6-weapon Floor 1 release panel and record the resulting Sweep Results Viewer run.

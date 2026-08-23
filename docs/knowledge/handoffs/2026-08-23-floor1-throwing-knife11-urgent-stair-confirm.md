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
- Recovered review feedback by keeping the original shared Floor 1 8ft stair
  marker contract. `autoFloor1ProgressionSystem` remains gated by the same
  `objective.markerRadiusFt` used by the shipped interaction prompt.
- Fixed the underlying final-stair convergence in `BehaviorTreeAI`: once the
  Floor 1 stairs are unlocked and are the current target, close-range movement
  switches to direct local navigation so the AI physically enters the canonical
  marker instead of treating the terminal stair target like a suppressible
  unreachable explore waypoint.
- Recovered the follow-up Headless Floor 1 Gate failure (`seed=21`, forced bow):
  while the player is inside a safe room, `BehaviorTreeAI` no longer lets
  RETREAT or NPC-approach threat-clearing select weapon-combat responses that
  cannot make progress with safe-room weapon immunity active. It falls back to
  progression/egress first, then resumes combat outside the safe room.
- Recovered the subsequent Headless Floor 1 Gate economy failure by restoring
  the shared Floor 1 stair marker to 8ft; the 24ft marker let runs exit earlier
  and pushed median unspent spendable gold above the economy gate.
- Added deterministic regression coverage:
  `tests/headless/floor1-throwing-knife11-release-regression.test.ts`, plus a
  parity test proving collapse urgency does not auto-descend from outside
  `objective.markerRadiusFt`.

## Observe before done (real artifact)

- **Before:** direct headless run (`runHeadless` sweep-equivalent settings, forced throwing-knife seed 11, Floor 1 release frame cap) timed out at 660s.
- **After:** same settings now produce deterministic victory within the same frame cap (paired reruns in regression test). A direct post-fix run cleared at frame 32,422 (540.4s) with `floor1-leave-floor` complete. The seed-selected PR gate regression (`seed=11`, baseball-bat) clears at frame 32,400 with the original shared 8ft marker preserved.
- **CI recovery:** the rebased branch reproduced the Headless Floor 1 Gate
  failure for `seed=21`, forced bow: the run timed out at the frame cap while
  stuck in safe-room RETREAT / NPC-threat-clear loops before claiming the Spell
  Broker reward. After the safe-room combat-yield fix, the existing
  `floor1-planning-deadline` regression passes.
- **Economy recovery:** `tests/headless/floor1-economy-gate.test.ts` passes with
  the original 8ft marker restored, while `floor1-throwing-knife11-release-regression`
  still passes.

## Verification Run

- `npm test -- --run tests/headless/floor1-completion.test.ts`
- `npm test -- --run tests/headless/floor1-throwing-knife11-release-regression.test.ts`
- `npm test -- --run tests/game/auto-progression-npc.test.ts`
- `npm test -- tests/headless/floor1-planning-deadline.test.ts`
- `npm test -- tests/headless/floor1-economy-gate.test.ts`
- `npm run typecheck`
- `npm run verify:fast`
- GitHub-backed Floor 1 release panel: pending dispatch after repair push.

## Unresolved / Follow-ups

- Publish the repair commit, then dispatch the 50-seed × 6-weapon Floor 1 release panel and record the resulting Sweep Results Viewer run.

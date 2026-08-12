# Session Handoff: Tutorial Hunt Target Fixation Regression

## Date

2026-08-11

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, ai-pathfinding

## Apples

Estimated 4 apples, rescored to 2 apples after investigation. Current main already
contained the narrow runtime fix and its behavior-tree regression, so the final
merge-intent change is one real-headless outcome and determinism guard.

## Summary

- Reproduced the reported sword seed 14 stall at the exact weapon-sweep SHA
  `9ef7730f3cd742c7719823262b5243d5464a73e9`, using legacy decision/pathing modes
  and the existing 23,760-frame budget.
- Confirmed the historical run stalled after 22,929 frames with zero kills, 100%
  health, and 21,600 ENGAGE decisions while the Floor 1 tutorial quest remained
  incomplete.
- Traced the apparent unreachable-target symptom to the safe-room doorway
  commitment failure already fixed by PR #1212: Hunt stole control when the
  coarse `playerInSafeRoom` flag flickered at the threshold, pulling the player
  back across the boundary indefinitely.
- Verified current main already preserves the committed safe-room egress waypoint
  and has focused unit coverage for that state-machine invariant.
- Added a real `headless-runner.ts` regression that pins sword seed 14 to an
  official victory within 23,760 frames, requires tutorial completion and at
  least one kill, and compares deterministic gameplay metrics across two
  sequential replays.

## Real Headless Evidence

Historical baseline:

`tsx src/game/ai/headless-runner-cli.ts --seed 14 --weapon sword --pathing-mode legacy --decision-mode legacy --max-frames 23760 --max-time-ms 600000 --weapon-personas --weapon-telemetry`

- SHA: `9ef7730f3cd742c7719823262b5243d5464a73e9`
- Outcome: `stalled`
- Frames: 22,929
- Kills: 0
- Final HP: 100%
- Stall: Floor 1 tutorial progress frozen for 360 seconds

Current production pipeline:

`tsx src/game/ai/headless-runner-cli.ts --seed 14 --weapon sword --pathing-mode riskRewardFused --decision-mode legacy --max-frames 23760 --max-time-ms 600000 --weapon-personas --weapon-telemetry`

- Outcome: `victory`
- Frames: 15,617
- Kills: 43
- Final level: 6
- Minimum HP: 55.7%
- Floor 1 tutorial completed at 43.4 seconds

## Verification

- `npx vitest run tests/headless/floor1-hunt-fixation-regression.test.ts --project headless --reporter=dot`
- `npm run verify:fast`
- `npm run check:wired-systems`

All passed. No gameplay, ranged-spacing, boss-arena, balance, or runtime AI source
was changed.

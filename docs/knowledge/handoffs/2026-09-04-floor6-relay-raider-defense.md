# Session Handoff: Floor 6 Relay Raider Defense Targeting

## Date

2026-09-04

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, ai-headless-runner

## Apples

3🍎 estimated, 3🍎 actual (exact).

## Summary

Release baseline run `33896862159` for commit
`8bb1361b3dcf78aceeaca7515c70edcdcf059863` reported the Floor 6 report-only
leg at 134/150 wins (89.33%), below the 90% target.

The published `baselines` payload showed all 16 Floor 6 losses were the same
bucket: `outcome=timeout` with `floor6Defense.terminalOutcome=defeat`,
`relayHp=0`, no player death, no live/stalled raiders at terminal cleanup, high
movement efficiency, and decision time dominated by `EXPLORE`.

## Root Cause

Floor 6 starts directly in relay-defense flow, but the generic BT Hunt branch is
gated on the Floor 1 tutorial quest. Raiders outside immediate engage radius
therefore did not become movement targets on Floor 6; the runner explored until
raiders were already near the relay, which was too late for seeds like 36.

## What Changed

- Added a Floor 6-only BT branch that runs during `DEFEND`/`FINALE` and treats
  live `BroadcastRelayRaider` entities as relay-defense objectives.
- The selector A\*-filters reachable raiders, ranks by distance to the relay
  first, then player distance and eid for deterministic ties, and routes through
  the existing engagement planner.
- Added a unit regression proving Floor 6 raiders are intercepted without Floor
  1 tutorial Hunt state and that the closest-to-relay threat wins.
- Added a real headless regression for release-baseline seed 36.

No weapon, health, damage, spawn, map-generation, or defense tuning values were
changed.

## Real-Pipeline Evidence

Observed through `npm run ai:headless` with the release Floor 6 frame budget
(`--floor floor6 --max-frames 9900 --no-force-weapon`):

| Seed | Before                                  | After                                    |
| ---: | --------------------------------------- | ---------------------------------------- |
|   36 | timeout at 66.6s, 1 kill, 92.5% EXPLORE | victory at 60.8s, 13 kills, 87.6% ENGAGE |
|   47 | timeout in published baseline           | victory at 62.3s, 13 kills               |

Release data reference: `project:sweep-results-viewer runId=33896862159`.

## Verification

- `npx vitest run tests/unit/ai/floor6-relay-defense.test.ts tests/headless/floor6-release-gate.test.ts`: passed (4/4)
- `npm run ai:headless -- --floor floor6 --seed 36 --max-frames 9900 --max-wall-time-ms 30000 --no-force-weapon`: passed, victory
- `npm run ai:headless -- --floor floor6 --seed 47 --max-frames 9900 --max-wall-time-ms 30000 --no-force-weapon`: passed, victory
- `npm run verify:fast`: passed (815 files / 11,514 tests)

## Unresolved Issues

None for the categorized Floor 6 relay-defense AI bucket. The next release sweep
is the canonical re-measurement.

## Recommended Next Steps

Publish the ready-for-review PR and let CI run the full suite and the next
release sweep.

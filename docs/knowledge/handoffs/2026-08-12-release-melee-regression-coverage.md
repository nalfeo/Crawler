# Session Handoff: Release Melee Regression Coverage

## Date

2026-08-12

## Persona

Game AI Engineer

## Systems touched

ai-combat-balance, ai-pathfinding, mapgen, quests

## Apples

4🍎 estimated, 2🍎 actual (over). The original request anticipated a new runtime
fix; exact-SHA diagnosis showed that both causal runtime fixes were already on
main, so the merge-intent diff was reduced to one class-level headless guard.

## Problem

Release weapon sweep run `29564772319` at SHA
`e0087947c521aca7f42976c640fa9bac4af68dd0` reported seven melee failures under
the 19,800-frame budget with weapon personas disabled:

- baseball-bat seeds 17 and 86;
- sword seeds 23, 26, 64, 86, and 98.

These exact release cases were not covered together under the authoritative
budget and persona settings. Current-main success alone was not treated as
evidence that the historical failures had been fixed.

Sweep Results Viewer: `project:sweep-results-viewer runId=29564772319`.

## Exact-Release Diagnosis

The historical commit and its dependencies restored successfully in a detached
worktree. With `weaponPersonas: false`, every local replay matched the release
artifact outcome and metrics:

| Case            | Release outcome | Frames | Level | Kills |
| --------------- | --------------- | -----: | ----: | ----: |
| baseball-bat 17 | death           |  8,015 |     2 |    28 |
| baseball-bat 86 | timeout         | 19,800 |     9 |   111 |
| sword 23        | timeout         | 19,800 |     2 |    22 |
| sword 26        | death           | 14,369 |     6 |    66 |
| sword 64        | timeout         | 19,800 |     2 |    21 |
| sword 86        | timeout         | 19,800 |     9 |   110 |
| sword 98        | timeout         | 19,800 |     5 |    80 |

An exact-SHA A/B changing only pathing from the retired `legacy` mode to
`riskRewardFused` converted five cases to victories: baseball-bat 17 and sword
23, 26, 64, and 98. Both seed-86 weapons still timed out while seeking the
merchant fetch item on the same generated map.

The causal fixes therefore predate this session:

- `d514d02a5` promoted fused risk/reward pathing and fixed the five pathing
  failures.
- `6fcd2d845` bounded and merchant-anchored the required rat-tail placement,
  fixing the shared seed-86 quest-tour failure.

No additional AI runtime change was justified. An adversarial plan review
rejected coupling run-plan urgency into travel steering because it targeted
local steering rather than the diagnosed route-length defect and could weaken
healthy survival behavior.

## What Was Done

- Added all seven exact release weapon/seed pairs to the real-headless legacy
  regression suite.
- Pinned the authoritative 19,800-frame budget and explicitly disabled weapon
  personas.
- Required an official Floor 1 victory for every case.
- Ran every case twice and compared the complete deterministic `RunStats`
  payload after removing the sole wall-clock field.
- Made no runtime, weapon-balance, map-generation, quest, package, or workflow
  changes.

## Current-Main Real-Pipeline Evidence

Observed through `runHeadless` and the production AI simulation pipeline:

| Case            | Outcome | Frames |
| --------------- | ------- | -----: |
| baseball-bat 17 | victory | 14,423 |
| baseball-bat 86 | victory | 14,450 |
| sword 23        | victory | 14,532 |
| sword 26        | victory | 14,730 |
| sword 64        | victory | 14,401 |
| sword 86        | victory | 14,401 |
| sword 98        | victory | 17,478 |

Each paired rerun produced byte-identical deterministic `RunStats`. This is
after-state evidence for the already-merged causal fixes; the regression-only
PR does not claim to change runtime behavior.

## Validation

- Focused Floor 1 legacy headless regressions: 15/15 passed.
- `npm run verify:fast`: passed.
- `npm run check:wired-systems`: passed.
- `npm run verify:pr-prereqs`: passed.

## Blockers

None.

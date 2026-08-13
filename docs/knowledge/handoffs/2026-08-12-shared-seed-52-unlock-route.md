# Session Handoff: Shared Seed 52 Unlock Route

## Date

2026-08-12

## Persona

Game AI Engineer

## Systems touched

mapgen, quests, ai-combat-balance

## Apples

4🍎 estimated, 4🍎 actual (exact).

## Problem

The authoritative release baseline was weapon sweep run `31561657791` at commit
`9eb2290273f526cfffb5da47fadde946b2bc6c78`: 600 Floor 1 runs covering seeds
1-100 for sword, bow, baseball-bat, pistol, throwing-knife, and fireball. It
recorded 583 victories (97.17%) and 17 losses. Seed 52 failed for all six
weapons without a combat death:

| Case              | Baseline outcome | Time | Kills | Minimum HP |
| ----------------- | ---------------- | ---: | ----: | ---------: |
| sword 52          | error            |  42s |    14 |       100% |
| bow 52            | error            |  52s |    21 |        97% |
| baseball-bat 52   | error            |  57s |    17 |        94% |
| pistol 52         | error            |  43s |    14 |       100% |
| throwing-knife 52 | error            |  59s |    25 |        94% |
| fireball 52       | error            |  56s |    27 |        97% |

Local reruns at the authoritative SHA reproduced every record exactly and
identified `ObjectiveRoutePlannerError` (`unreachable-required-goal`) rather
than death or timeout.

## Root Cause

The selected Slime Rat room was outside the player's 4,909-tile connected
component after hypothetical acceptance of the Slime Rat quest. Its own doors
correctly became traversable, but its only physical connection to the main map
passed through the still-locked staircase room. Completing the staircase boss
requires first defeating the Slime Rat, creating a deterministic progression
topology cycle.

The placement selector validated the fetch item with both boss rooms locked,
but ranked Slime Rat rooms only by Euclidean separation. It could therefore
select a geometrically attractive arena that was unreachable in the exact
progression state where the player must enter it.

## What Was Done

- Added a progression-state reachability filter to Slime Rat room selection.
  Candidate rooms must be reachable from the merchant while staircase doors
  remain blocked; Slime Rat doors are traversable in this state.
- Preserved the existing Euclidean preference and all balance inputs among
  valid candidates. No weapon, combat, quest flag, or AI door behavior changed.
- Hoisted the invariant map-wide distance field outside the item-candidate loop.
- Extended the placement regression to model the staged lock state across seeds
  1-100, including merchant, Spell Broker, fetch item, and Slime Rat routes.

## Real-Pipeline Evidence

Observed through `runHeadless` and the production AI simulation pipeline with
the authoritative 19,800-frame budget and weapon personas enabled:

| Case              | Fixed outcome | Frames |   Time | Kills | Minimum HP |
| ----------------- | ------------- | -----: | -----: | ----: | ---------: |
| sword 52          | victory       | 14,435 | 240.6s |    58 |      53.1% |
| bow 52            | victory       | 14,500 | 241.7s |   111 |      55.3% |
| baseball-bat 52   | victory       | 14,530 | 242.2s |    79 |      79.5% |
| pistol 52         | victory       | 14,500 | 241.7s |    92 |      17.6% |
| throwing-knife 52 | victory       | 14,475 | 241.2s |    85 |      67.4% |
| fireball 52       | victory       | 14,578 | 243.0s |   125 |      85.3% |

All six cases became official victories between 14,435 and 14,578 frames.
Independent paired runs for every weapon produced byte-identical deterministic
`RunStats` projections after excluding wall-clock-only `wallTimeMs` and `fps`.

The authoritative 600-run distribution remains the broad evidence:
`project:sweep-results-viewer runId=31561657791`. This change targets its one
shared seed-52 topology class and does not touch seed 69 or isolated combat
deaths.

## Review

- The 4🍎 adversarial plan review rejected planner fallback, post-hoc connector
  carving, and provisional-placement-only alternatives.
- Code review found no behavioral defects.
- Multi-model review found and resolved three concerns: a reviewer-induced
  missing production edit, redundant per-candidate BFS work, and formatting.
  Gemini 3.1 Pro and Claude Sonnet 5 returned clean on the final round.
- Review ledger:
  `docs/knowledge/review-ledgers/2026-08-12-shared-seed-52-unlock-route.review-ledger.json`.

## Validation

- Staged-lock route regression over seeds 1-100: 4/4 tests passed.
- Exact six-weapon seed-52 headless gate: 6/6 official victories.
- Paired deterministic projections: 6/6 byte-identical.
- `npm run typecheck`: passed.
- `npm run verify:fast`: passed.
- `npm run check:wired-systems`: passed.

## Blockers

None.

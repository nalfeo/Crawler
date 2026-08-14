# Session Handoff: Align Floor 1 Planning Deadline With Runner Budget

## Date

2026-08-13

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, ai-combat-balance

## Apples

3🍎 estimated, 3🍎 actual (exact).

## Problem

The authoritative release baseline at
`30cb03d287de26863f5ca183715ff586f643ba5a` recorded 596/600 wins in run
`31677512099`. The isolated `bow-21` case timed out at the 23,760-frame
(396-second) safety cap despite 126 kills, 76.9% minimum HP, and the required
quest chains completing at 336.7 seconds.

The Floor 1 manifest advertises a 600-second collapse deadline, but release
evaluation grants 360 seconds of active time plus a 396-second raw safety cap.
The run planner consumed the manifest value while the evaluator enforced the
shorter budget, leaving about 132 seconds of fictitious slack near the cap and
delaying staircase urgency.

## What Was Done

- Added `floor1-run-budget.ts` as the single source of truth for the 360-second
  active budget, 23,760-frame default safety cap, frame-derived runner deadline,
  and effective planning deadline.
- Propagated the actual headless frame budget into budget-aware AI providers
  before the real simulation pipeline starts.
- Made the main run planner, middle-chain planner, collapse panic profile, and
  stair-descend auto-progression resolve the same minimum of manifest, active,
  and runner deadlines.
- Invalidated all deadline-sensitive planner and merchant caches when a reused
  provider receives a different runner budget.
- Replaced duplicated evaluator budget constants in the win-rate sweep, Floor 1
  gate sample, and sweep evaluator.
- Added an explicit `planningMaxFrames` override for observation-only diagnostic
  slices. Normal evaluators remain coupled by default because the override
  defaults to `maxFrames`; the collision-pair parity slice declares its short
  1,500-frame cutoff as observation-only.

The 600-second manifest deadline and the 23,760-frame release safety cap remain
unchanged. No weapon, health, damage, spawn, or seed-specific values changed.

## Real-Pipeline Evidence

Observed through production `BehaviorTreeAI` and `runHeadless`, with weapon
personas enabled and the release 23,760-frame cap:

| Metric                   |     Before |              After |
| ------------------------ | ---------: | -----------------: |
| Outcome                  |    timeout |            victory |
| Frames                   |     23,760 |             18,934 |
| Game time                |     396.0s |             315.6s |
| Kills                    |        126 |                131 |
| Minimum HP               |      76.9% |              67.6% |
| Final HP                 |      86.7% |             101.5% |
| Required chains complete |     336.7s |             225.5s |
| Leave-floor objective    | incomplete | complete at 315.6s |

Two paired post-fix `bow-21` reruns were byte-identical after excluding only
`wallTimeMs`.

## Safety Sample

Seeds 1, 8, and 21 were sampled before and after across sword, bow, and
baseball-bat. All eight previously healthy cases remained victories; only
`bow-21` changed outcome.

| Weapon       | Seed | Before          | After           |
| ------------ | ---: | --------------- | --------------- |
| sword        |    1 | victory, 241.0s | victory, 241.0s |
| sword        |    8 | victory, 243.6s | victory, 240.3s |
| sword        |   21 | victory, 297.9s | victory, 290.7s |
| bow          |    1 | victory, 243.0s | victory, 243.0s |
| bow          |    8 | victory, 244.9s | victory, 245.4s |
| bow          |   21 | timeout, 396.0s | victory, 315.6s |
| baseball-bat |    1 | victory, 244.4s | victory, 244.4s |
| baseball-bat |    8 | victory, 242.4s | victory, 240.0s |
| baseball-bat |   21 | victory, 300.9s | victory, 303.0s |

## Regression Coverage

- `tests/unit/floor1-run-budget.test.ts` locks frame conversion, validation,
  deadline-minimum semantics, provider reconfiguration, and cache reset.
- `tests/headless/floor1-planning-deadline.test.ts` runs exact `bow-21` twice
  through the real Behavior Tree/headless pipeline, requiring an official
  victory and paired determinism.
- `tests/headless/headless-runner-telemetry.test.ts` locks default frame-budget
  propagation, zero-frame compatibility, and explicit observation-only budget
  behavior.
- `tests/headless/collision-pair-parity.test.ts` proves observation-only slices
  preserve their production planning horizon and deterministic fingerprints.
- `tests/unit/floor1-gate-sample.test.ts` locks evaluator constants to the shared
  runtime budget module.

## Review

- Plan review (`gpt-5.4`) rejected a raw-cap-only design and drove the minimum of
  active, manifest, and runner deadlines plus evaluator-wide constant
  consolidation.
- Code review (`claude-sonnet-4.6`) completed two rounds and finished clean.
- Independent grade (`gemini-3.1-pro-preview`) initially found the short-slice
  planning-cap compatibility defect; after the explicit observation-only
  contract and regression were added, it passed all five criteria at 5/5.
- Review ledger:
  `docs/knowledge/review-ledgers/2026-08-13-planner-deadline-mismatch.review-ledger.json`.

## Validation

- Exact paired `bow-21` headless regression: passed.
- Nine-case before/after safety sample: 8/8 prior victories preserved, with
  `bow-21` upgraded to victory.
- Collision parity and headless-runner telemetry: 18/18 passed.
- `npm run verify:fast`: passed.
- `npm run check:wired-systems`: passed.
- `npm run verify:pr-prereqs`: passed.
- Review ledger validation: passed.

## Blockers

None.

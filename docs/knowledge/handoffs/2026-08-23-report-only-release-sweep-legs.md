# Session Handoff: Report-only release sweep Floor 2 progression regression

## Date

2026-08-23

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, ai-pathfinding

## Apples

3🍎 estimated / 2🍎 actual (diagnosis + validation only; no new code was needed on
this branch)

## What Was Done

Closed #3368 by diagnosing the published release baseline payload for commit
`e986debd30135cb43ef1b2d51eaaf85df41055d3` and confirming the current branch
already contains the AI-runner fix from #3327 / `3f7f827`.

The issue's release sweep (`32618823235`;
`project:sweep-results-viewer runId=32618823235`) reported `floor2` at 36.00%
and `floor1-chain` at 51.33%. The workflow itself completed successfully; the
regression was in report-only leg data rather than a failed CI job.

Diagnosis used only the already-published baseline JSON from the `baselines`
branch:

`by-sha/e986debd30135cb43ef1b2d51eaaf85df41055d3.json`

No replacement sweep was dispatched.

## Published RunStats categorization

The dominant failure bucket is AI-runner-solvable and matches the Floor-2
collapse-deadline blindness fixed by #3327:

| Leg            | Outcomes                                      | Largest loss bucket                                                      |
| -------------- | --------------------------------------------- | ------------------------------------------------------------------------ |
| `floor2`       | 54 victory / 89 timeout / 5 death / 2 stalled | 74 timeouts after all 4 family dens were unlocked, entered, and defeated |
| `floor1-chain` | 77 victory / 71 timeout / 1 death / 1 stalled | 55 timeouts after all 4 family dens were unlocked, entered, and defeated |

Correlations for that largest bucket:

- `floor2`: median last den defeat at 806.5s, median stuck 27.4%, median wiggle
  13.2%; aggregate decision time was dominated by `ENGAGE` (~39,295s),
  `EXPLORE` (~34,610s), and `COLLECT` (~14,888s).
- `floor1-chain`: median last den defeat at 723.8s, median stuck 28.4%, median
  wiggle 13.9%; aggregate decision time was dominated by `ENGAGE` (~27,726s),
  `EXPLORE` (~25,854s), and `COLLECT` (~12,415s).

That shape means the runner was commonly clearing Floor 2, unlocking the exit,
then continuing to explore/collect until collapse instead of descending.

## Fix status

No new production code was added in this session because the branch already
contains the fix:

- `src/game/ai/collapse-deadline.ts`
- `BehaviorTreeAI.getCollapsePanicProfile(...)` reading manifest-timer collapse
  state when `world.floorScenario?.objective` is absent
- `autoFloor2ProgressionSystem(...)` passing the Floor-2 manifest deadline into
  stair-descend deferral
- deterministic coverage in
  `tests/unit/ai-floor-collapse-deadline.test.ts` and
  `tests/integration/floor2-collapse-panic-exit.test.ts`

This is the smallest safe branch delta for #3368: preserve the inherited
AI-runner fix and add issue-specific evidence rather than re-touching behavior
that is already corrected on `main`.

## Validation

- `bash scripts/agent/preflight.sh`: passed.
- `npm test -- --run tests/unit/ai-floor-collapse-deadline.test.ts tests/integration/floor2-collapse-panic-exit.test.ts`:
  passed, 6/6 tests.
- Real pipeline observation via single-seed headless run:
  `npm run ai:headless -- --floor floor2 --seed 6 --max-frames 72001`:
  `VICTORY` at 1095.6s, all four dens defeated, `floor2-leave-floor` completed,
  `Exit: completed`.

The next release sweep remains the canonical re-measurement for the report-only
leg win rates.

## Issue plan comment blocker

The maintainer asked for a detailed plan comment on issue #3368 before code
changes. I posted the plan in session progress before touching files, but the
available sandbox credentials could not post to the issue:

- `gh issue comment` without `GH_TOKEN`: rejected.
- `gh issue comment --repo nalfeo/Crawler` with available token: HTTP 403.
- direct REST `POST /repos/nalfeo/Crawler/issues/3368/comments`: HTTP 403 /
  proxy-blocked.

No source code was modified before these attempts.

## What's Next

No blocker remains for this issue branch. If the next release sweep still shows
low report-only Floor-2 progression rates, inspect the smaller residual bucket:
runs that never defeat all four dens before collapse (for example the
`lt4_defeated_timeout` category), which is a different pacing/target-selection
problem than unlocked-exit refusal.

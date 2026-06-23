# Session Handoff: Scoring Function, Hill-Climb Optimiser, Preview Deploy

## Date

2026-06-23

## Persona(s) adopted

Producer (primary) — cross-cutting task spanning AI metrics, perf tooling, and CI/deploy.

## Routing verdict

✅ right persona — task crossed AI analysis + tooling + deployment, requiring orchestration.

## Apples

Estimated: 🍎🍎🍎  
Actual: 🍎🍎🍎  
Verdict: 🎯 Exact

Hello kitties: 3/5 = 0.60 🎀

## What Was Done

### 1. Preview GH Pages deploy

PR #253 (`copilot/examine-behavior-tree-system`) already existed. The `manual-preview.yml`
workflow has an **admin-only guard** — the Copilot agent cannot trigger it (HTTP 403).
**Action required**: the user must trigger it manually from GitHub UI:

> Actions → "Deploy Manual Preview" → Run workflow → `preview_ref: copilot/examine-behavior-tree-system`, `pr_number: 253`

### 2. Antagonistic review + lint

Ran `parallel_validation` (code review + CodeQL) against the PR diff — **0 issues found**.
Ran `npm run verify:fast` — 1603 tests pass, lint clean.

### 3. `totalGold` added to `RunStats`

- `src/game/ai/types.ts`: new `totalGold: number` field on `RunStats`.
- `src/game/ai/headless-runner.ts`: wired `world.playerGold` into both the error-path return
  and the normal-path `stats` object.
- `src/game/ai/headless-runner-cli.ts`: prints `Total Gold:` in the summary output.

### 4. Scoring function (`src/game/ai/scoring.ts`)

Weighted composite score with strict priority order:

```
score = VICTORY_BONUS (1_000_000 if victory)
      + TIME_BONUS_WEIGHT × (1 - gameTimeMs/budget)   (when victory)
      + xpEfficiency × XP_WEIGHT (10)
      + totalGold × GOLD_WEIGHT (0.1)

xpEfficiency = totalXp / max(1, finalLevel)
```

Weights are sized so the ordering invariant holds in all plausible cases:

- Any victory beats any non-victory.
- XP efficiency dominates gold (10× vs 0.1×).
- Time bonus (10 000 max) rewards faster clears within the same victory tier.

Exports: `scoreRun(stats, maxGameTimeMs?)`, `aggregateScores(breakdowns[])`, `ScoreBreakdown`.
Both are re-exported from `src/game/ai/index.ts`.

### 5. Hill-climbing optimiser (`scripts/agent/perf/hill-climb.ts`)

Coordinate-ascent search over 8 `AIConfig` parameters:
`aggression`, `retreatThreshold`, `retreatDangerRadius`, `scanRadius`,
`rangedSafeDistance`, `opportunisticGrabRadius`, `dodgeWeight`, `collectPullWeight`.

Algorithm: probe ±step for each param, move to best-scoring neighbor; halve all steps
on no improvement; terminate when all steps < minStep or `--max-iters` reached.

npm script: `npm run ai:hill-climb -- [--seeds N,M] [--max-frames N] [--max-iters N]`

### 6. A/B hill-climb results (seeds 2, 4, 7 — 330s budget)

**Baseline**: score=334 568.8, victory rate=33% (seed 2 wins; seeds 4 and 7 die).

The hill-climber **converged after 2 iterations with no improvement** — the default config
is already at a local optimum of the coarse coordinate-ascent search.

Key findings:

- `collectPullWeight > 0.0` at any step size causes **0% victory** on seeds 4 and 7.
  This validates the handoff decision to keep the default at 0.0.
- `retreatThreshold` and `retreatDangerRadius` changes also hurt win rate on these seeds.
- No single-parameter perturbation improves the 3-seed win rate beyond 33%.

**Interpretation**: the AI's inability to clear seeds 4 and 7 within 330s is **not a
parameter-tuning problem** — it is a structural behavior problem. Parameter hill-climbing
has reached its ceiling. Improvements will require:

1. Better exploration routing (avoid backtracking into already-cleared areas).
2. Smarter retreat — distinguish "heal-up" retreat from "stuck in corner" situations.
3. Re-enabling `collectPullWeight` with a waypoint-window limit (next 3–5 waypoints only).
4. Farm/dodge weights: re-evaluate once exploration is fixed.

Seed 2 remains the canonical headless gate for this branch.

## What's Next

- **Preview deploy**: user triggers `manual-preview.yml` from GH UI for PR #253.
- **Structural AI work**: improve exploration routing to crack seeds 4 and 7.
  Consider adding a "revisit penalty" map so the AI avoids already-explored tiles.
- **Re-enable collectPullWeight**: test with waypoint-window sweep (next 5 waypoints)
  once exploration is improved and add seeds to the gate.
- **Hill-climb with larger seed panel**: add seeds 8, 10, 12 once win rate > 50%.

## Blockers

- Preview deploy blocked by admin-permission requirement on `manual-preview.yml`.

## Branch State

- Branch: `copilot/examine-behavior-tree-system`
- All tests passing: ✅ (1603 tests)
- `npm run verify:fast`: ✅
- PR: open (#253)

## Test Results

- ✅ `npm run verify:fast` (1603 tests)
- ✅ `npx tsc --noEmit`
- ✅ `npm run ai:hill-climb -- --seeds 2 --max-frames 19800 --max-iters 3` (smoke test)
- ✅ `npm run ai:hill-climb -- --seeds 2,4,7 --max-frames 19800 --max-iters 15` (full run)

## Key Decisions Made

- Scoring weights (VICTORY_BONUS=1M, XP_WEIGHT=10, GOLD_WEIGHT=0.1, TIME_BONUS=10K) sized
  so priority order is preserved at all realistic metric values.
- Hill-climb uses coordinate ascent (one param at a time) with step-halving fallback; this
  keeps each iteration O(2N) evals rather than exponential grid search.
- `TunableKey` union type used for `steps` record to keep TypeScript strict without `keyof
AIConfig` string/symbol ambiguity.

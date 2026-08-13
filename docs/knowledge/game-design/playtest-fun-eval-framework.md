# Playtest "Fun" Evaluation Framework

This defines a repeatable, telemetry-only way to rate gameplay sessions for fun:

- deterministic telemetry from `RunStats`
- optional event and item telemetry as those producers are added

Implemented by:

- `scripts/agent/health/fun-score-lib.ts`
- `scripts/agent/health/fun-score.ts`
- skill wrapper: `.github/skills/playtest-fun-rater/SKILL.md`

## Goals

- Make "fun" trendable across branches and seeds.
- Avoid one-off anecdotal judgments.
- Keep CI-compatible scoring deterministic by default.

## Input contract

Accepted input JSON:

- `RunStats[]`
- `{ "runs": RunStats[] }`
- `{ "sessions": [{ "id": "...", "run": RunStats, "survey"?: Survey }] }`

Legacy survey fields may be supplied for exploratory analysis, but they are not
required by the evaluator:

- `enjoyment`
- `immersion`
- `mastery`
- `control`
- `tension` (reverse-scored)

Runs may also carry a deterministic evaluator persona:

- `new_player`
- `experienced_player`
- `min_max_cheeser`
- `explorer`

The headless CLI exposes these through `--persona`. Personas are behavioral
cohorts, not hidden difficulty modifiers; reports must retain per-persona
results so an expert-heavy average cannot hide a new-player failure.

## Score model

Dimension scores (0-100):

- engagement (25%)
- challenge_balance (18%)
- excitement (18%)
- pacing (14%)
- competence_growth (11%)
- choice_depth (7%)
- run_distinctness (7%)

Objective score = weighted sum of dimensions.

`sameness_grade = 100 - run_distinctness`.

- Lower sameness is better.
- This is intentionally expected to be mediocre while Floor 1 is heavily scripted.
- It should improve as floors/weapons/spells/build paths expand.

Overall score:

- with surveys: blend subjective weight by survey coverage  
  `subjective_weight = 0.4 * survey_coverage`  
  `overall = objective * (1 - subjective_weight) + subjective * subjective_weight`
- without surveys: objective only

## Gate defaults

- `min_overall = 70`
- `min_dimension = 55`

A run-set fails if `gate.gating_overall_score` is below `min_overall` or any
core gated dimension is below `min_dimension`.

`gating_overall_score` excludes `run_distinctness` for now, so sameness can be
tracked without hard-failing Floor 1 heavy samples.

Current gate does **not** fail solely on `run_distinctness`; it is tracked as a
forward-looking quality signal and hotspot driver.

## Non-gating fun criteria

The evaluator also reports criteria independently of the overall score:

| Criterion                 | Current target                                  | Status when telemetry is absent                  |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------ |
| Unsafe-zone combat uptime | >=75%                                           | `unmeasured` until zone-aware combat time exists |
| Survivability variance    | Meaningful outcome spread; inspect tails        | Measured from run outcomes                       |
| Run variety               | `run_distinctness` >=60                         | Measured                                         |
| Dopamine cadence          | No gap >90s during active play                  | `unmeasured` until timestamped events exist      |
| Snowball/cheese frequency | Epic outlier runs <=10%                         | `unmeasured` until a deterministic signal exists |
| Permanent-power slope     | Slow positive run-over-run slope                | `unmeasured` until meta progression exists       |
| Item viability            | No exposed item is inert or permanently avoided | `unmeasured` until item telemetry exists         |

These criteria are diagnostic and trendable, not PR gates. `FunScoreReport`
emits aggregate means, persona breakdowns, sample size (`runs`), and
confidence; it does **not** carry per-run distributions or seed/run
identifiers. Callers that report a criterion must therefore preserve the input
run set (seeds and run ids) alongside the report so tails stay inspectable and
the numbers stay reproducible.

## Confidence model

Confidence (0-1) combines:

- sample size sufficiency (target 300 deterministic runs for high confidence)
- score stability (lower variance = higher confidence)
- survey coverage (when present)

## Operational policy

Recommended seed counts for deterministic comparisons:

- smoke: 20+
- PR-quality directional check: 100+
- release-quality confidence: 300+

Use matched seed sets across baseline/candidate to reduce variance.

## Usage

```bash
tsx scripts/agent/health/fun-score.ts --input files/playtests/floor1-runs.json
tsx scripts/agent/health/fun-score.ts --input files/playtests/floor1-runs.json --baseline files/playtests/baseline.json --out files/playtests/fun-score.json
```

When `--baseline` is supplied, the output includes non-gating
`improving`/`degrading`/`inconclusive`/`unmeasured` comparisons for the overall
score, dimensions, and measurable criteria.

## Interpretation guidance

- High objective + low subjective: mechanics may be performant but not satisfying.
- Low pacing + low engagement together usually indicates dead air / objective stalls.
- Low choice_depth across many runs indicates build variety pressure (often loadout/tuning issue).
- High sameness_grade indicates runs are converging into one experience profile.

Treat recommendations as hypotheses; confirm with another seed batch after changes.

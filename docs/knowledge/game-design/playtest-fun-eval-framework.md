# Playtest "Fun" Evaluation Framework

This defines a repeatable way to rate gameplay sessions for fun using a blend of:

1. deterministic telemetry from `RunStats`
2. optional post-session survey scores

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

Survey fields are optional 1-5 scores:

- `enjoyment`
- `immersion`
- `mastery`
- `control`
- `tension` (reverse-scored)

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

- with surveys: `0.6 * objective + 0.4 * subjective`
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
tsx scripts/agent/health/fun-score.ts --input files/playtests/floor1-runs.json --min-overall 72 --min-dimension 58 --out files/playtests/fun-score.json
```

## Interpretation guidance

- High objective + low subjective: mechanics may be performant but not satisfying.
- Low pacing + low engagement together usually indicates dead air / objective stalls.
- Low choice_depth across many runs indicates build variety pressure (often loadout/tuning issue).
- High sameness_grade indicates runs are converging into one experience profile.

Treat recommendations as hypotheses; confirm with another seed batch after changes.

# Playtest "Fun" Evaluation Framework

This defines a repeatable, telemetry-only way to rate gameplay sessions for fun:

- deterministic telemetry from `RunStats`
- timestamped positive-event, item opportunity/use, and snowball feature telemetry

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

| Criterion                 | Current target                                  | Status when telemetry is absent                   |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------- |
| Unsafe-zone combat uptime | >=75%                                           | `unmeasured` until zone-aware combat time exists  |
| Survivability variance    | Band 0.14-0.45 std dev of normalized outcome    | Measured from run outcomes                        |
| Run variety               | `run_distinctness` >=60                         | Measured                                          |
| Dopamine cadence          | No gap >90s during active play                  | `unmeasured` for legacy/malformed event telemetry |
| Snowball/cheese frequency | Epic outlier runs <=10%                         | `unmeasured` below 10 complete official wins      |
| Permanent-power slope     | Slow positive run-over-run slope                | `unmeasured` until meta progression exists        |
| Item viability            | No exposed item is inert or permanently avoided | `unmeasured` for legacy/no selectable exposures   |

These criteria are diagnostic and trendable, not PR gates. `FunScoreReport`
emits aggregate means, persona breakdowns, sample size (`runs`), and
confidence; it does **not** carry per-run distributions or seed/run
identifiers. Callers that report a criterion must therefore preserve the input
run set (seeds and run ids) alongside the report so tails stay inspectable and
the numbers stay reproducible.

### Event-level telemetry contract

`runHeadless` emits three optional evidence blocks on both normal and error
returns. Older artifacts omit them, so the evaluator treats a mixed old/new
cohort as `unmeasured` rather than scoring a biased subset.

- `dopamineTelemetry`: ordered `level_up`, `quest_complete`, `boss_kill`, and
  rare generated-loot selection events. Each event carries raw game time and
  safe-room-adjusted active time; the block carries terminal active duration.
- `itemTelemetry`: stable catalog identity, item kind, offered opportunities,
  selectable opportunities, selections, activations, and equipped active time.
  It covers starter weapons, boss/Broker spells, and generated equipment.
- `snowballSignals`: active clear duration, damage per active minute, kills per
  active minute, and dominant unique-item activation share.

Runtime weapon/ability hooks record only successful untimestamped activations.
The headless runner exclusively owns active time and acquisition observation, so
game systems do not depend on evaluator policy.

Generated equipment is grouped by base ID, rarity, sorted slots, normalized
effect/grant kinds, and source weapon. Per-run instance IDs, ordinals,
fingerprints, item/enhancement levels, and rolled numeric values are excluded.

### Criterion formulas

**Dopamine cadence.** Events are ordered by active time and exact duplicate
`(kind, sourceId, activeTimeMs)` records are removed. The evaluator includes the
start-to-first and last-to-end boundary gaps; a run with no events has one gap
equal to its full active duration. `observed` is the worst per-run gap in seconds.
The reason also reports the fraction of active duration in gaps no longer than
90 seconds. Every measured run must have a maximum gap of at most 90 seconds.

**Snowball frequency.** Only official victories with complete signals are
eligible, and at least ten are required. For active clear time (lower is more
extreme), damage rate, kill rate, and item-use dominance (higher is more extreme),
the evaluator computes the conventional modified robust z-score:
`0.6745 * distance-from-median / MAD`. A zero-MAD feature contributes no evidence.
A run is an epic snowball only when at least two non-zero-MAD features reach
`z >= 3.5`. `observed` is classified runs divided by eligible wins and is healthy
at `<= 0.10`; no percentile cutoff mechanically forces ten percent.

**Item viability.** Catalog entries aggregate across runs using selectable
exposures as the denominator. An exposed item is flagged when it is never
selected, selected below 10% after at least five selectable exposures, or selected
but has neither activations nor equipped active time. `observed` is flagged
catalog items divided by evaluable exposed items; the target is zero. Lower is
better in baseline comparisons.

**Meta progression.** `RunStats.metaProgression` reserves normalized
`permanentPowerBefore` and `permanentPowerAfter` values. If every ordered session
provides valid values, the evaluator reports average fractional increase and
expects a slow-positive `>0%` to `5%` band. Crawler has no permanent-upgrade
producer today: the Production Office/full meta-progression system is planned but
deferred, so real runs continue to report this criterion as `unmeasured` without
fabricated values.

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

Comparisons are cohort-aware. The report carries a `comparison.cohort` block,
and when the two cohorts drift materially in run count or persona mix (>10%),
every measured status is downgraded to `inconclusive`: `run_distinctness` is
sample-size sensitive and persona mix changes behavior, so an unmatched pair
can move purely from composition. Use matched seed sets and a matched persona
mix for any comparison you intend to act on.

Survivability variance is compared against its healthy **band**, not by
direction: both a monotone (too little spread) and a coin-flip (runaway spread)
cohort are unhealthy, so movement is scored by distance to the band.

A persona label is only recorded when the run actually used the preset. If
`--aggression`, `--pathing-mode`, or `--decision-mode` overrides a persona
value, the CLI warns and leaves `playerPersona` unset so the run cannot
contaminate that cohort's rollup.

## Interpretation guidance

- High objective + low subjective: mechanics may be performant but not satisfying.
- Low pacing + low engagement together usually indicates dead air / objective stalls.
- Low choice_depth across many runs indicates build variety pressure (often loadout/tuning issue).
- High sameness_grade indicates runs are converging into one experience profile.

Treat recommendations as hypotheses; confirm with another seed batch after changes.

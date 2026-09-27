# Playtest "Fun" Evaluation Framework

Evaluator v2 reports deterministic **uncalibrated heuristic diagnostics**. It
cannot establish whether Crawler is enjoyable without human evidence. The
existing Floor-1 requirement (at least 90% easy wins) remains separate.

Implemented by `scripts/agent/health/fun-score-lib.ts` and `fun-score.ts`, with
`.github/skills/playtest-fun-rater/SKILL.md` as the evaluation workflow.
`release-fun-report.ts` scores available release legs and writes
`.cache/baseline/fun-report.json`; published artifacts remain at
`by-sha/<sha>.fun-report.json` on the baselines branch. These reports do not
block release. Historical reports remain readable but are explicitly legacy
and must never be compared with v2 as evidence of improvement.

## Input and provenance

Accepted inputs are `RunStats[]`, `{ "runs": RunStats[] }`, or
`{ "sessions": [{ "id": "...", "run": RunStats, "survey": {} }] }`.
Survey fields are optional 1–5 responses: enjoyment, immersion, mastery,
control, and tension. Each field has its own response count and mean; absent
responses are unmeasured. Tension is retained as reported, not reverse-scored.
Surveys are never blended into the heuristic. Human enjoyment is unmeasured
unless direct enjoyment responses are present.

Only sessions explicitly attributed with `run.evaluationContext.source: 'human'`
contribute observed survey responses. Headless or unattributed survey attachments
cannot establish human enjoyment. Survey coverage uses human sessions as its
denominator, keeping bot volume out of human-response coverage.

The headless presets `new_player`, `experienced_player`, `min_max_cheeser`, and
`explorer` describe bot behavior. They are not validated human cohorts. Retain
preset breakdowns and source provenance (`headless`, `human`, or `unknown`).
An override of aggression/pathing/decision behavior must not retain an
inaccurate preset label.
Release sweeps explicitly instantiate and label the production
`experienced_player` preset. Flattened multi-floor records combine whole-chain
time with final-floor counters; those counters are unavailable as whole-chain
measurements, rather than silently scoring a mismatched numerator/denominator.

## Versioned report

`schema_version: 2`, `interpretation: 'uncalibrated_heuristic'`,
`confidence: null`, and `confidence_reason` make the interpretation explicit.
`overall_fun_score` and `objective_score` retain historical API names for
compatibility; present them as **Heuristic diagnostic** in user interfaces.
Scores and dimensions may be null. Missing evidence must never become zero.

Dimensions are engagement, challenge_balance, excitement, pacing, progression,
choice_depth, and run_distinctness. Progression describes measured progression,
not psychological competence. Power increases are not penalized merely for
exceeding a fixed damage, kill, XP, or level target. Choice depth, run
distinctness, and sameness grade remain unmeasured until telemetry supports
actual choices/build diversity. Starter-weapon coverage is descriptive coverage,
not choice depth. Outcome/timing dispersion is not build variety.

`evidence` exposes unique scenarios, duplicate scenarios, unidentified runs,
starter-weapon coverage, and per-dimension coverage. `per_run` retains run IDs,
scenario identity, source, dimensions, and heuristic score. Scenario identity
comes from reproducible scenario context, including the release leg or an
explicit session scenario tag, not arbitrary run IDs. Repeating a
fixture is not independent evidence. Preserve source artifacts for reproduction.

`observed_surveys` reports each raw survey field separately. No run count,
low variance, or repeated fixture raises a claim of confidence in enjoyment.

## Diagnostic gate and criteria

The existing defaults (`min_overall = 70`, `min_dimension = 55`) are design
assumptions, not empirically validated enjoyment thresholds. The diagnostic gate
excludes unimplemented choice depth and run distinctness. Unknown required
measurements fail the gate and appear in `gate.unmeasured_dimensions`; a missing
score cannot silently pass. This does not change the independent gameplay or
release gates.

Criteria remain separate from the composite. `reward_cadence` observes gaps
between recorded rewards, including start/end boundaries; reward count alone
cannot establish reward payoff. `performance_outlier_frequency` describes
statistical extremes, not exploits or unsatisfying dominance. Survivability
variance is descriptive, with no preferred band that conflicts with easy wins.
A `descriptive` criterion status denotes a measured, uncalibrated observation.
Null targets mean there is no calibrated target. Legacy or malformed telemetry
must remain unmeasured.

Item viability uses selectable opportunities, selections, activations, and
equipped time as hypotheses for investigation. Unsafe combat uptime needs
zone-aware observations; an enemy existing somewhere is insufficient evidence.
Permanent-power slope requires genuine meta-progression observations. Do not
fabricate telemetry for absent systems.

## Comparisons and operation

Use matched scenario identities, preset/source composition, floors, weapons,
and evaluator versions. Missing identities, duplicate scenarios, incompatible
versions, or mismatched cohorts prevent an improvement claim. A numerical delta
is a heuristic change, never proof that human enjoyment improved. Inspect
per-run distributions and reproducible tails as well as aggregates.

A missing bot preset makes comparisons inconclusive. Human-source sessions
also make comparisons inconclusive: a seed is not participant identity, and the
evaluator has no participant-aware study design.

```bash
tsx scripts/agent/health/fun-score.ts --input files/playtests/floor1-runs.json
tsx scripts/agent/health/fun-score.ts --input files/playtests/candidate.json --baseline files/playtests/baseline.json --out files/playtests/fun-score.json
```

More than ten runs default to GitHub workflow dispatch. Run counts are coverage
budgets, not validated confidence tiers. Report exact commands, seeds, identities,
missing measurements, and the producing workflow. Confirm any tuning hypothesis
with matched evidence; do not change tuning automatically.

## What still requires players

Validate enjoyment, meaningful choice, power growth, crafting payoff, exciting
versus frustrating tension, readability, and voluntary replay with target
players. Rendered-agent observations can identify confusing moments with clips
and timestamps, but do not replace those responses. Future predictors must be
validated on held-out players and builds before making enjoyment claims.

## Local combat-pressure diagnostics

`RunStats.combatPressure` and available live recorder stats carry a separate v1
mechanics diagnostic. The v2 evaluator exposes it per run without changing scores,
criteria, comparisons, UX routing, or independent win gates. Missing or malformed
records remain unmeasured. Live coverage requires an injected session recorder;
this work does not collect human data or infer enjoyment. Flattened multi-floor
records remain unmeasured because final-floor evidence cannot describe a chain.

The spatial hypothesis counts living player-hostile mobs with direct line of
sight within `max(12 ft, min(authored attack range, 32 ft))`, respecting delayed
aggro, aggro range, faction targeting and inactive bosses. Twelve feet is a local
reaction-neighborhood hypothesis; the 32-foot cap limits long-range authored
attacks to local pressure. Neither distance is calibrated. A missing floor map
uses the existing open-arena convention. This is an actionable-neighborhood
proxy, not a prediction of an immediate hit: cooldowns, stun, support abilities,
projectiles already in flight, hazards and indirect paths are not modeled.

Only adjacent valid samples at most 250ms apart contribute measured time.
`threatenedMs` is exposed time with at least one local threat;
`unthreatenedMs` is valid outside-safe-space time without one. Safe rooms (including
Floor4 countdown), invalid observations and gaps are excluded and break all
rolling windows. Entering or leaving safety excludes the boundary interval.
The first observation is only a baseline. Finite zero-health endpoints can record
a fatal health decrease; a removed player cannot. These exclusions deliberately
favor incomplete evidence over fabricated exposure.

Burst evidence is explicitly **net health loss**, not combat-event damage:
`peakNetHealthLoss1s` is the largest sum of observed decreases over a trailing
one-second interval. Concurrent healing can hide damage, and max-health changes
can confound it. A recovery window is at least two seconds without a local threat
or net loss, below full health, after observed pressure; it is an opportunity,
not evidence of actual healing. Meaningful downtime is at least three seconds
without a local threat or net loss after pressure. Qualifying windows include
their initial two/three seconds and ongoing tails. Initial exploration is not
combat downtime. Damage, renewed pressure, safety and invalid gaps interrupt
windows. These temporal thresholds are hypotheses, not preferred difficulty or
pacing targets. No threat-free sample establishes safety from unmodeled hazards.

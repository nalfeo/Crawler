---
name: playtest-fun-rater
description: >-
  Rate gameplay sessions for "fun" using deterministic telemetry + optional
  survey signals. Use when asked to "rate fun", "score playtests",
  "compare branch fun", "run a playtest eval", "evaluate gameplay feel", or
  "gate fun regression". Produces a structured scorecard with dimension scores,
  confidence, hotspots, and pass/fail gates.
---

# Playtest Fun Rater

Score gameplay sessions with a repeatable rubric that blends objective run
telemetry with optional player survey data. This skill is for
**evaluation/reporting**, not auto-tuning gameplay numbers.

## When to use

Use this skill when the request is about:

- Rating one or more gameplay sessions for "fun"
- Comparing fun between baseline and candidate branch runs
- Building a fun scorecard for balance/playtest reviews
- Detecting regressions in gameplay feel from deterministic runs

## Workflow (required order)

1. **Collect session data**
   - Gather run JSON from headless/playtest output.
   - Require at least 20 sessions for directional signal; 100+ for stronger confidence.
2. **Run deterministic scoring**
   - Execute:
     `tsx scripts/agent/health/fun-score.ts --input <path-to-json>`
   - Use explicit thresholds when gating:
     `--min-overall <n> --min-dimension <n>`.
3. **Review hotspots**
   - Inspect low dimensions and outlier runs in the report.
   - Confirm whether failures cluster by outcome/weapon/seed family.
4. **Optional subjective blend**
   - If survey responses are present in input (`survey` per session), include them.
   - If absent, report objective-only scoring and lower confidence.
5. **Publish structured findings**
   - Report must include score table, gate verdict, confidence, and top recommendations.

## Output contract

Always report:

1. `overall_fun_score` (0-100)
2. Dimension scores (0-100):
   - `engagement`
   - `challenge_balance`
   - `excitement`
   - `pacing`
   - `competence_growth`
   - `choice_depth`
   - `run_distinctness`
3. `sameness_grade` (0-100):
   - lower is better (0 = runs feel very distinct, 100 = runs feel highly samey)
4. `gate` verdict:
   - includes `gating_overall_score` (core dimensions only) and pass/fail vs `min_overall` + `min_dimension`
5. `confidence` (0-1) with explanation
6. `hotspots`: dimensions/runs dragging score down
7. `recommendations`: prioritized, evidence-backed actions

## Guardrails

- Do not claim "fun improved" from a single run.
- Do not replace deterministic telemetry with LLM-only judgment.
- Do not auto-edit tuning/system code during this skill; produce findings first.
- Do not hide low confidence; surface sample-size and survey-coverage limits.
- Do not ignore sameness trends even when overall score is passing.

## Input shape accepted by scorer

The scoring script accepts JSON as:

- `RunStats[]`
- `{ "runs": RunStats[] }`
- `{ "sessions": [{ "id": "...", "run": RunStats, "survey"?: {...} }] }`

`survey` is optional and supports 1-5 scales:
`enjoyment`, `immersion`, `mastery`, `control`, `tension` (reverse-scored).

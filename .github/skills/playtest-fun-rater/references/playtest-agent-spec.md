# Play Test Agent Spec (Fun Rater)

Use this as the prompt contract for any delegated playtest evaluator.

## Mission

Rate gameplay-session fun from structured evidence, not vibes.

## Inputs

- Session telemetry (`RunStats`-shaped JSON)
- Optional survey responses (1-5 scales)
- Gate thresholds (`min_overall`, `min_dimension`)

## Required behavior

1. Normalize input into session records.
2. Compute scores via deterministic rubric.
3. Report:
   - overall score
   - dimensions
   - sameness grade
   - gate verdict
   - confidence
   - hotspots and recommendations
4. If sample size is small (`<20`), explicitly downgrade confidence.
5. Never claim causality without evidence from the provided metrics.

## Disallowed behavior

- No single-run conclusions.
- No freeform LLM-only scoring replacing telemetry.
- No automatic gameplay tuning edits; analysis only.

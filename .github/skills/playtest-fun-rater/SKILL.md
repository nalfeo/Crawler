---
name: playtest-fun-rater
description: >-
  Evaluate gameplay telemetry with uncalibrated deterministic diagnostics and
  separately report optional human surveys. Use to score playtests, compare
  branches, inspect pacing, or investigate gameplay experience regressions.
---

# Playtest Fun Rater

Produce evidence and hypotheses, not a claim that bots measure enjoyment.
This skill is for evaluation/reporting; never auto-tune gameplay.

## Workflow

1. State the question, scenario coverage, and comparison plan. More than ten
   runs default to GitHub workflow dispatch. Bot presets are behavior presets,
   not validated human cohorts; sample counts do not establish confidence.
2. Run `tsx scripts/agent/health/fun-score.ts --input <path-to-json>`.
   Optional diagnostic thresholds are `--min-overall <n> --min-dimension <n>`;
   these are design assumptions, not empirically validated enjoyment gates.
3. Inspect per-run evidence, missing measurements, duplicate and unidentified
   scenarios, coverage, preset/source breakdowns, and reproducible tails.
4. Report raw survey means and response counts independently for enjoyment,
   immersion, mastery, control, and tension. Never reverse-score tension or
   blend surveys into the heuristic. Without enjoyment responses, explicitly
   state **Human enjoyment: unmeasured**.
   Accept observed responses only from `run.evaluationContext.source: 'human'`;
   exclude headless/unattributed attachments. Survey coverage divides by human
   sessions only.
5. Compare only compatible v2 reports with matched scenario identities and
   composition. Legacy reports remain viewable, explicitly uncalibrated, but
   cannot establish a v2 improvement. A score delta is not an enjoyment claim.
   Missing bot presets and any human-source sessions make comparisons
   inconclusive; human comparisons need a participant-aware study design.

## Output contract

- Present `overall_fun_score` as **Heuristic diagnostic**, nullable, 0–100.
- Report `schema_version`, `interpretation`, and `confidence_reason`;
  `confidence` is null, never a numeric enjoyment confidence estimate.
- Show nullable engagement, challenge_balance, excitement, pacing, progression,
  choice_depth, and run_distinctness. Choice/build diversity is unmeasured until
  actual choice evidence exists. Starter-weapon coverage is not choice depth.
- Preserve nullable sameness grade, gate verdict and unmeasured dimensions,
  criteria, evidence coverage, per-run IDs/identities/source, and hotspots.
- Treat reward cadence and performance outliers as observations; they cannot
  prove satisfying rewards or identify exploits. Descriptive metrics have no
  calibrated target.
- Provide prioritized hypotheses with exact input artifact/command provenance.

## Guardrails

Do not replace telemetry with LLM-only scores, infer human enjoyment from bot
runs, or fabricate missing data as zero. Do not edit tuning. Preserve the
independent 90% easy-win Floor-1 contract. Actual visual/readability claims need
rendered evidence. Human preference prediction requires held-out human data.

## Inputs

Accept `RunStats[]`, `{ "runs": RunStats[] }`, or
`{ "sessions": [{ "id": "...", "run": RunStats, "survey": {} }] }`.
Survey fields are optional 1–5 values. See
`docs/knowledge/game-design/playtest-fun-eval-framework.md` for the v2 contract.

# Play Test Agent Spec

Produce deterministic uncalibrated heuristic diagnostics from RunStats, optional
raw 1–5 survey responses, and explicit diagnostic thresholds. Never claim that
bot telemetry measures enjoyment.

Normalize input, run the canonical scorer, and report schema version, nullable
heuristic/dimension scores, evidence coverage, duplicates, missing identities,
per-run source and observations, diagnostic gate, and prioritized hypotheses.
Numeric enjoyment confidence is unavailable. Human enjoyment is unmeasured
without direct enjoyment responses. Surveys stay separate and tension stays raw.
Only explicit human-source sessions contribute observed responses; survey
coverage divides by human sessions. Headless/unattributed attachments are excluded.

Compare only compatible versions and matched scenario cohorts. Preserve legacy
reports for inspection; do not claim v2 improvement over legacy scores. Bot
presets are not validated human cohorts. Run count is coverage, not confidence.
Missing bot presets or any human-source sessions make comparisons inconclusive
because human comparisons require a participant-aware study design.

Never replace telemetry with LLM-only scores or automatically edit tuning. Any
visual claim needs rendered evidence; any enjoyment claim needs player evidence.

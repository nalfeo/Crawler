# ADR 0004: Chronicle as Agent-OS Telemetry Backend

## Status

Accepted

## Date

2026-06-05

## Context

The Crawler agent-OS has three infrastructure layers that operate without feedback:

1. Pre-tool hooks (copilot-guards) — 9 guards enforcing conventions
2. Instruction files — 4 glob-matched `.instructions.md` files
3. Memory system — 3-tier constitution → policies/ADRs → handoffs

Without telemetry, we cannot answer:

- Which guards are useful vs. dead weight?
- Which guards produce false positives?
- Which memory docs should be promoted or archived?
- Are instruction files effective at preventing violations?

The Memory Policy defines promotion/retirement thresholds (3+ sessions for promotion, 30 days for archival) but has no mechanism to measure them.

## Decision

Use **Chronicle** (`session_store_sql`) as the telemetry backend for agent-OS self-observation.

1. **Active emission:** The `copilot-guards` extension emits structured `[guard-telemetry]` JSON log events via `session.log()` on every guard decision.

2. **Passive signals:** Chronicle already captures `session_files` (which docs are opened), `events` (tool executions), and `turns` (conversation context). These provide memory access and instruction effectiveness signals without additional instrumentation.

3. **Daily analysis workflow:** A Copilot CLI scheduled workflow queries chronicle and files a GitHub issue with recommendations (promote/prune/tune). Gated on new sessions existing.

4. **Human-in-the-loop:** All actions (archival, promotion, guard tuning) require human approval. The system recommends; it never auto-executes.

## Consequences

### Positive

- Evidence-based memory governance (no more guessing which docs are stale)
- Guard effectiveness becomes measurable (fire-rate, false positives, dead guards)
- Feedback loop enables Hashimoto's Loop (observe → classify → fix → test → audit)
- Zero new infrastructure — uses existing session store
- Reports are GitHub issues — visible, trackable, actionable

### Negative

- `session.log()` output may not be fully queryable in chronicle (needs empirical verification)
- Adds ~5 async log calls per tool invocation in the guard path (minimal latency impact since they're fire-and-forget)
- Daily issues could become noisy if thresholds are too sensitive

### Risks

- Chronicle data retention policy is controlled by GitHub, not us — old events may age out
- If `session.log()` doesn't land in queryable columns, we'll need a fallback (local JSON append file)
- Analysis queries may need tuning as data volume grows

## Alternatives Considered

1. **Local JSON telemetry file** — Guards write to `.copilot/telemetry.jsonl`. Simpler emission, but requires a separate reader and doesn't benefit from chronicle's cross-session queryability.

2. **GitHub Actions workflow** — Run analysis in CI. Rejected because it can't access chronicle (session data is local to the Copilot CLI app).

3. **Custom MCP server** — Build a telemetry MCP that guards emit to. Over-engineered for the current scale; chronicle already exists.

4. **No telemetry** — Continue operating blind. Rejected because the memory policy defines thresholds (3+ sessions, 30 days) that are impossible to measure without observation.

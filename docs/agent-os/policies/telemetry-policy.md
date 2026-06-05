# Telemetry Policy

## Purpose

Define how the Crawler agent-OS infrastructure observes itself and uses that data to improve over time. Telemetry drives enhancement (promote useful things) and pruning (archive/disable dead things).

## Telemetry Backend

**Chronicle** (`session_store_sql`) — the built-in session history store that captures events, turns, tool executions, and file accesses across all Copilot CLI sessions.

No additional infrastructure required. All analysis is read-only queries against existing data.

## What Gets Tracked

### Guard Telemetry (active emission)
The `copilot-guards` extension emits a structured `[guard-telemetry]` log event on every guard decision:
- `guard_id` — which guard fired
- `tool_name` — which tool triggered it
- `decision` — deny, ask, allow, skip, bypass, crash
- `reason` — why (for deny/ask/crash)
- `bypass_used` / `bypass_reason` — if disabled via env or config

### Memory Access (passive, from session_files)
- Which `docs/knowledge/**` files are accessed per session
- Which instruction files matched (via file pattern correlation)

### Session Patterns (passive, from events/turns)
- Session count per day
- Tool usage distribution
- Turn count / token usage trends

## Analysis Cadence

- **Daily** — automated workflow runs at 08:00, files a GitHub issue with findings
- **Skips** if zero new sessions occurred in the trailing 24 hours
- **Reports** cover trailing 7-day (fire-rate), 14-day (memory freshness), and 30-day (archival) windows

## Thresholds

| Signal | Threshold | Action |
| --- | --- | --- |
| Dead guard | 0 fires in 14 days | Flag for review → disable or remove |
| High false-positive guard | >30% deny-then-retry pattern | Flag for tuning (loosen or reword) |
| Stale handoff | >30 days old, 0 session references | Flag for archival |
| Promotion candidate (T3→T2) | 3+ unique sessions accessing the doc | Flag for promotion |
| Promotion candidate (T2→T1) | Referenced in 5+ sessions AND violations occur without it | Rare; requires human judgment |
| Crash-prone guard | 3+ crashes in 7 days | Investigate; consider failOpen or fix |

## Governance

- **All actions require human approval.** The telemetry system recommends; humans decide.
- **No auto-pruning.** Reports flag candidates; a human reviews and approves.
- **No auto-promotion.** Same principle — the report suggests, human executes.
- **Privacy:** Telemetry is project-scoped. No PII is emitted. Guard telemetry contains tool names and guard decisions only.

## Report Delivery

Reports are filed as GitHub issues on `nalfeo/Crawler` with labels `agent-os` and `telemetry`. This makes recommendations:
- Visible in the repo
- Actionable (can be assigned, commented on, closed)
- Trackable over time (issue history = telemetry history)

## Relationship to Memory Policy

This policy extends the Memory Policy's retirement rules with evidence-based signals:
- Memory Policy says "archive handoffs >30 days" — telemetry confirms which ones are actually stale
- Memory Policy says "promote after 3+ sessions reference it" — telemetry provides the count
- Memory Policy says "nothing is deleted, only archived" — telemetry respects this (flags, never deletes)

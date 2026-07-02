# Telemetry Policy

## Purpose

Define how the Crawler agent-OS infrastructure observes itself and uses that data to improve over time. Telemetry drives enhancement (promote useful things) and pruning (archive/disable dead things).

## Telemetry Backend

**Durable backend:** session handoffs in `docs/knowledge/handoffs/`.

**Capture path:** the `copilot-guards` extension appends guard events to the
session-local artifact `files/guard-telemetry.jsonl`. Near session end, the agent
runs `npm run telemetry:capture -- <session-slug>` to write a committed,
contamination-filtered per-session summary under
`docs/knowledge/metrics/guard-telemetry/<YYYY-MM-DD>-<slug>.json`. This structured,
per-session file is the durable cross-session collection path (conflict-free, rides
the session's normal commit). Pasting a summary block from
`npx tsx scripts/agent/docs/guard-telemetry.ts --handoff-section` into the handoff
remains a supported fallback; the analyzer unions both sources and de-duplicates by
session (a committed capture file wins over a handoff block for the same session).

**Contamination guard:** guard-dev sessions run the extension's own test suite,
whose dispatcher fixtures (`boom`, `ctx*`, `edit-bad`, `pr-*`, `shell-*`) previously
leaked into the artifact. The analyzer now (a) quarantines any record carrying a
known test-fixture id — dropping its synthetic real-id counts too — and (b) drops
unknown/typo ids individually with a warning while keeping the real session. The
dispatcher tests themselves write telemetry to a throwaway temp dir, so they can no
longer pollute the repo-root artifact.

**Optional enrichment:** Chronicle (`session_store_sql`) remains a best-effort
source for passive local analysis when it is queryable, but the repository does
not depend on Chronicle for cross-session telemetry anymore.

## What Gets Tracked

### Guard Telemetry (active emission)

The `copilot-guards` extension emits a structured `[guard-telemetry]` log event
on every guard decision and appends the same payload to
`files/guard-telemetry.jsonl`:

- `guard_id` — which guard fired
- `tool_name` — which tool triggered it
- `decision` — deny, ask, allow, skip, bypass, crash
- `reason` — why (for deny/ask/crash)
- `bypass_used` / `bypass_reason` — if disabled via env or config

### Memory Access (passive, from committed docs)

- Which `docs/knowledge/**` files are referenced by newer handoffs/ADRs
- Which instruction files are repeatedly associated with violations (via
  handoff summaries and guard telemetry)

### Session Patterns (passive, from git + handoffs)

- Session count per day
- Tool usage distribution
- Turn count / token usage trends

## Analysis Cadence

- **Daily** — automated workflow runs at 08:00, files a GitHub issue with findings
- **Skips** if zero new sessions occurred in the trailing 24 hours
- **Reports** cover trailing 7-day (fire-rate), 14-day (memory freshness / telemetry coverage), and 30-day (archival) windows

## Thresholds

| Signal                      | Threshold                                                                                                                             | Action                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Dead guard                  | 0 fires in 14 days, **with** family evidence (≥10 configured-guard events in its `shell`/`edit`/`pr` family across ≥3 clean sessions) | WARN → flag for review (disable/remove). Below that evidence bar the guard is reported as low-confidence **unobserved**, not dead. |
| High false-positive guard   | >30% deny-then-retry pattern                                                                                                          | Flag for tuning (loosen or reword)                                                                                                 |
| Stale handoff               | >30 days old, 0 session references                                                                                                    | Flag for archival                                                                                                                  |
| Promotion candidate (T3→T2) | 3+ unique sessions accessing the doc                                                                                                  | Flag for promotion                                                                                                                 |
| Promotion candidate (T2→T1) | Referenced in 5+ sessions AND violations occur without it                                                                             | Rare; requires human judgment                                                                                                      |
| Crash-prone guard           | 3+ crashes in 7 days                                                                                                                  | Investigate; consider failOpen or fix                                                                                              |

## Governance

- **All actions require human approval.** The telemetry system recommends; humans decide.
- **No auto-pruning.** Reports flag candidates; a human reviews and approves.
- **No auto-promotion.** Same principle — the report suggests, human executes.
- **Privacy:** Telemetry is project-scoped. No PII is emitted. Guard telemetry contains tool names, guard IDs, decisions, and optional deny/ask reasons only.

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

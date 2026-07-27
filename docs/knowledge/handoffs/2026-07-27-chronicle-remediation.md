# Handoff: Chronicle 2026-07-27 Remediation

## Date

2026-07-27

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 2🍎, actual 2🍎. (Tooling-only; capped at 3🍎 per policy.)

## Summary

Implemented all five actionable items from the Chronicle Agent-OS Daily Health
Check report (issue #2125). Changes are documentation, telemetry, and
developer-tooling only — no gameplay or runtime behavior affected.

---

## What Was Done

### 1. 🔴 Guard-id + tool attribution in `permissionDecisionReason`

**Problem:** The session-store `events` table has NULL `tool_start_name` for
guard-denied tool calls (tool was pre-empted, never started), making it
impossible to attribute denials by tool from Chronicle SQL queries.

**Fix:** Updated `formatDeny()` and `formatPrAggregate()` in
`.github/extensions/copilot-guards/lib/dispatcher.mjs` to embed both the guard
id and the denied tool name in every `permissionDecisionReason` string:

```
[copilot-guards/<id> | tool:<toolName>] <reason>
```

For PR aggregate denials, each guard line now carries its own parseable marker:

```
❌ [copilot-guards/pr-preflight | tool:create_pull_request] <reason>
❌ [copilot-guards/pr-review-ledger | tool:create_pull_request] <reason>
```

The fail-closed crash denial uses the same format.

Also documented the Chronicle query patterns in the guards README:

```sql
-- All guard denials
WHERE tool_complete_result_content ILIKE '%[copilot-guards/%'
  AND tool_complete_result_content ILIKE '%"permissionDecision":"deny"%'
-- Extract every guard id: regexp_extract_all(..., '\[copilot-guards/([^|]+) \| tool:([^\]]+)\]', 1)
-- Extract every tool:     regexp_extract_all(..., '\[copilot-guards/([^|]+) \| tool:([^\]]+)\]', 2)
```

Added two new tests in `dispatcher.test.mjs` that pin the format.

### 2. 🟡 Archived 180 June 2026 handoffs

Moved all 180 `docs/knowledge/handoffs/2026-06-24-*` through
`2026-06-25-*` (and all June dates) to `docs/knowledge/handoffs/archive/`.
These had 0 access in the 14-day window per the Chronicle report.

The `build-system-index.ts` already skips the `archive/` directory, and
`preflight.sh`'s `handoff_digest` uses `maxdepth 1` — so neither the INDEX
nor the preflight lessons digest are affected.

### 3. 🟡 Consolidated merge-train handoff cluster

Created `docs/knowledge/handoffs/2026-07-27-merge-train-system-overview.md`
synthesizing the 7+ fragmented merge-train handoffs from July 14–22 into a
single living reference. The original session handoffs remain in place.

The document covers:

- Architecture overview (key scripts and their roles)
- Key design decisions (squash-merge promotion, TOCTOU fix, wakeup dispatch,
  job-level concurrency, ruleset vs. classic protection)
- Known failure patterns and mitigations table
- Aggregated lessons learned
- Source handoff cross-reference table

### 4. 🟢 Added `extensions_reload` reminder to preflight

Added a single `printf` line immediately after the `main_sync` phase in
`scripts/agent/preflight.sh` that reminds agents to run `extensions_reload`
after every sync onto main. Preflight already runs `sync:main --reason
session-start` at startup, so the reminder fires every session.

### 5. 🟢 Promoted `adr/0007-spatial-units-architecture.md` visibility

Added a `📌 Pinned ref` note to the `persona_hint` section of `preflight.sh`
that fires whenever the diff touches `Systems Engineer` or `Game Designer`
paths. Points to ADR 0023 (the canonical current doc) and notes that ADR 0007
has been superseded. This closes the loop on the 10-session access rate for
the stale ADR.

---

## Files Changed

| File                                                                          | Change                                                                |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `.github/extensions/copilot-guards/lib/dispatcher.mjs`                        | Attribution format in `formatDeny`, `formatPrAggregate`, crash denial |
| `.github/extensions/copilot-guards/tests/dispatcher.test.mjs`                 | 2 new attribution format tests                                        |
| `.github/extensions/copilot-guards/README.md`                                 | Chronicle query patterns section                                      |
| `scripts/agent/preflight.sh`                                                  | `extensions_reload` reminder + ADR 0023 pinned ref                    |
| `docs/knowledge/handoffs/2026-07-27-merge-train-system-overview.md`           | New consolidated doc                                                  |
| `docs/knowledge/handoffs/archive/2026-06-24-*.md` through `2026-06-25-*` etc. | 180 files moved to archive                                            |

---

## Validation

- Guard dispatcher tests pass (including per-aggregate-marker coverage).
- Added a 2🍎 review ledger and validated it.
- No TS errors from my changes (pre-existing vite.config.ts errors unrelated).
- Secret scan: clean.
- Archive move: 180 files moved, 0 remaining in main handoffs dir from 2026-06.

---

## Retrospective

### Lessons Learned

- Guard denial format was already partially queryable (`[copilot-guards/id]`),
  but adding the tool name makes Chronicle attribution fully self-contained even
  when `tool_start_name` is NULL in the schema.
- The `archive/` convention is already built into `build-system-index.ts` and
  `preflight.sh` — batch archiving is a no-op from a tooling perspective.

### Mistakes Made

- None; this was a straightforward remediation session.

### Opportunities for Future Improvement

- The Chronicle report suggests querying `docs/knowledge/metrics/guard-telemetry/`
  committed files directly in the next Chronicle run for richer per-guard
  fire-rate analysis.
- The merge-train overview doc should be updated as new incidents are resolved.

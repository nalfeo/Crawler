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

Use a **handoff-backed telemetry pipeline** for durable cross-session observation,
with Chronicle (`session_store_sql`) retained as optional local enrichment when it
is queryable.

1. **Active emission:** The `copilot-guards` extension emits structured
   `[guard-telemetry]` JSON log events via `session.log()` on every guard
   decision **and** appends the same payload to the session-local artifact
   `files/guard-telemetry.jsonl`.

2. **Durable transport:** Before ending the session, the agent pastes the output
   of `npx tsx scripts/agent/docs/guard-telemetry.ts --handoff-section` into the
   required session handoff. This makes guard telemetry durable across desktop
   and cloud sessions because handoffs are committed to the repository.

3. **Passive signals:** Git history plus committed handoffs/ADRs remain the
   passive cross-session source for memory freshness, promotion candidates, and
   session activity.

4. **Automation:** Repo automation analyses committed handoff telemetry and docs
   state in scheduled workflows. Chronicle, when queryable, can still be used
   for richer local inspection, but it is no longer a hard dependency.

5. **Human-in-the-loop:** All actions (archival, promotion, guard tuning)
   require human approval. The system recommends; it never auto-executes.

## Consequences

### Positive

- Evidence-based memory governance (no more guessing which docs are stale)
- Guard effectiveness becomes measurable (fire-rate, false positives, dead guards)
- Feedback loop enables Hashimoto's Loop (observe → classify → fix → test → audit)
- Works across desktop and mobile/cloud because the durable layer is the repo
- Reports are GitHub issues — visible, trackable, actionable

### Negative

- Requires agents to include the generated telemetry block in the handoff for
  full cross-session coverage
- Adds one local JSONL append per guard decision in the guard path (fire-and-forget)
- Daily issues could become noisy if thresholds are too sensitive

### Risks

- Coverage depends on handoff discipline; missing telemetry blocks reduce signal
- Analysis thresholds may need tuning as telemetry-bearing handoffs accumulate
- Chronicle data retention/queryability is still controlled by GitHub when used
  as an auxiliary source

## Alternatives Considered

1. **Chronicle-only telemetry** — Rejected after the baseline report because the
   emitted `session.log()` events were not available in queryable session-store
   tables, leaving guard fire-rates empty.

2. **Local JSON telemetry file only** — Better than Chronicle-only for capture,
   but not durable across sessions unless agents manually move the data into the
   repository anyway.

3. **GitHub Actions workflow only** — Rejected because CI cannot see the live
   session-local telemetry unless the session writes it into a committed artifact
   such as the handoff.

4. **Custom MCP server** — Build a telemetry MCP that guards emit to.
   Over-engineered for the current scale.

5. **No telemetry** — Continue operating blind. Rejected because the memory
   policy defines thresholds (3+ sessions, 30 days) that are impossible to
   measure without observation.

## Amendment (2026-07-02) — Contamination filter, committed capture path, evidence gating

The baseline pipeline shipped but was effectively blind. A guard-infra audit found
three defects, repaired here (measurement only — no guards were pruned):

1. **Contamination filtering.** The analyzer did not restrict aggregation to the
   configured guard ids, so the extension's own dispatcher-test fixtures (`boom`,
   `ctx*`, `edit-bad`, `pr-*`, `shell-*`) — plus synthetic counts for the real id
   `edit-guard-self-protection` they wrote alongside — leaked into the report. The
   analyzer now loads the configured ids from
   `.github/extensions/copilot-guards/config.json`, quarantines any record carrying
   a known test-fixture id (dropping its synthetic real-id counts too), and drops
   unknown ids individually with a warning while keeping the real session. The
   dispatcher tests were also isolated to a temp `cwd` so they can no longer append
   to the repo-root `files/guard-telemetry.jsonl`.

2. **Committed capture path is now the preferred durable transport.** Decision #2's
   hand-pasted `--handoff-section` block is retained as a supported fallback, but the
   primary path is `npm run telemetry:capture -- <slug>`, which writes a committed,
   contamination-filtered per-session summary under
   `docs/knowledge/metrics/guard-telemetry/<YYYY-MM-DD>-<slug>.json`. The analyzer
   unions both sources and de-duplicates by session (committed capture wins).

3. **Evidence-gated dead-guard reporting replaces the coverage-ratio defer.** The
   report previously refused to run until paste-coverage ≥ 50%, so it never ran at
   real ~12% coverage. It now always runs and grades each guard: a 0-fire guard is
   flagged **dead (WARN)** only when its `shell`/`edit`/`pr` family has enough real
   volume to trust a zero (≥10 configured-guard events across ≥3 clean sessions);
   otherwise it is reported as low-confidence **unobserved**. See
   `docs/agent-os/policies/telemetry-policy.md` for the operational thresholds.

Decision #1's `session.log()` emission is unchanged but remains best-effort only
(not queryable in the session store); the committed artifacts above are the
authority. This amendment does not change the human-in-the-loop rule (#5).

# Session Handoff: [Brief Description]

## Date

YYYY-MM-DD

## Persona(s) adopted

<!-- Which persona(s) you selected from docs/agent-os/personas/README.md, and why.
     For orchestrated work, name the Producer plus the specialists it routed to. -->

## Routing verdict

<!-- Was the routing right? One of: ✅ right persona | 🔀 another persona would
     have fit better (name it) | 🧩 needed Producer to split. One sentence why. -->

## Apples

Estimated: 🍎 x N <!-- declared before work began -->
Actual: 🍎 x N <!-- honest assessment at handoff time -->
Verdict: [🎯 Exact | 📉 Under | 📈 Over | 💥 Miss] — one sentence on why the gap exists (or "N/A" if exact)

Hello kitties: N/5 = N.NN 🎀 <!-- actual_apples / 5, two decimal places -->

## Review Harness

<!-- Required for code-touching changes. Name the review-ledger path and the
     stages you ran per the apple tier (see
     docs/agent-os/policies/review-harness-policy.md). Example:
     Ledger: docs/knowledge/review-ledgers/2026-06-29-<slug>.review-ledger.json
     Stages: plan_review ✅ · dual_plan_synthesis ✅ · code_review ✅ · multi_model_review ✅
     `npm run review:ledger -- validate <path>` → pass. Or "N/A — docs/art-only". -->

## What Was Done

<!-- Summary of changes made this session -->

## Runtime / real-artifact observation

<!-- Required for any wiring or runtime-behavior change (rule #10). Name the REAL
     artifact you observed the behavior in — the game (`npm run dev`) or a headless
     pipeline / win-rate gate (src/engine/sim/simulation-step.ts,
     src/game/ai/simulation-step.ts, src/game/ai/headless-runner.ts) — NOT a lab.
     A green lab only proves the system works in isolation; it can never prove the
     real game calls it (see the spawnerSystem inert-ship failure, ADR 0039).
     State the before/after you saw. Use "N/A — no wiring/behavior change" only
     when genuinely applicable. -->

## What's Next

<!-- What should the next session focus on? -->

## Blockers

<!-- Any blockers or issues encountered -->

## Branch State

- Branch: `[branch-name]`
- All tests passing: [yes/no]
- PR created: [yes/no, link]

## Agent-OS Telemetry

<!-- If `files/guard-telemetry.jsonl` exists, run `npm run telemetry:capture -- <session-slug>`
     to write a committed, contamination-filtered per-session summary under
     `docs/knowledge/metrics/guard-telemetry/`. That structured file is the durable
     collection path the analyzer reads. Pasting the output of
     `npx tsx scripts/agent/docs/guard-telemetry.ts --handoff-section` below still
     works as a fallback for legacy tooling. -->

Guard telemetry captured via: [`npm run telemetry:capture` | handoff block below | none]

## Test Results

<!-- Output of verify-fast.sh or verify.sh -->

## Key Decisions Made

<!-- Any architectural or design decisions made -->

## Retrospective

<!-- Required. An honest retrospective so the next agent compounds on this
     session instead of repeating it. "None" is rarely the right answer for
     any subsection — be specific. -->

### Lessons Learned

<!-- What did you learn that a future agent should know? Environment quirks,
     non-obvious gotchas, approaches that worked well. -->

### Mistakes Made

<!-- Honest accounting of wrong turns, dead ends, or errors — even ones you
     recovered from. Include what the early signal was, so the next agent
     catches it sooner. -->

### Opportunities for Future Improvement

<!-- Process, tooling, or codebase improvements surfaced by this work that were
     out of scope here but are worth a future session. -->

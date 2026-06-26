# Handoff — 2026-06-26 pr2c-followup-parity-guardrails

## Date

2026-06-26

## Persona(s) adopted

**Producer** — a small post-merge follow-up to PR2c (a test + handoff docs)
responding to the PR2 coordinator's review guardrails. Same persona as the parent
PR2c session.

## Routing verdict

✅ right persona — a test + documentation closeout, no new system.

## Apples

Estimated: 🍎 (declared for this follow-up — one parity test + handoff edits)
Actual: 🍎
Verdict: 🎯 Exact — added a single CI-safe e2e parity assertion and strengthened
the PR2c handoff. The only wrinkle was process, not code: PR2c (#347) had already
auto-merged before the coordinator's guardrails arrived, so these land as a small
follow-up PR rather than extra commits on #347.

Hello kitties: 1/5 = 0.20 🎀

## What Was Done

The parent PR2c (#347, squash `cc0a858`) merged via auto-merge + the `rebase-prs`
automation **before** the coordinator's GREENLIGHT guardrails were delivered. Two
of those guardrails were genuine, low-risk improvements, so this follow-up lands
them on top of the merged epic:

1. **Normal-Judge parity guard (coordinator guardrail #2)** —
   `tests/e2e/sprite-workflow-sensors.test.ts` gains a 4th test asserting the
   plain **Judge** button POSTs an **empty body** (`{}`) — no `force` /
   `variantIndexes`. Mirrors PR2b-1's parity discipline: the shared `runJudge`
   refactor only ADDS the force option, so the default judge call stays
   byte-identical to PR2b-2 (the sidecar still applies the sensor gate). The
   wiring lives in the un-exported `devtools-main.ts` render closure, so e2e is
   the right level (it is what proves the button→payload path).

2. **Handoff strengthening (coordinator guardrails #1, #4, #5)** — edits to
   `docs/knowledge/handoffs/2026-06-26-pr2c-sensor-viz-force-judge.md`:
   - **#1** records the three carry-forward verdicts against the **ADR 0023
     review-note lineage** (atomic `put` → implemented; tolerant `loadRunSummary`
     → already-satisfied; stale `processed/NN.judge.json` → won't-fix/cosmetic).
   - **#4** adds a concrete graceful-degradation trace for `loadRunSummary`:
     typed `RerunError` → sidecar `resolveRunForRerun` returns a structured HTTP
     error → devtools `fetchJson` rejects → `runJudge` catch reverts the stage and
     surfaces `Judge failed: …` (no hard crash; with atomic `put` the only live
     case is missing-file).
   - **#5** adds a 1:1 DoD-checklist → evidence map and notes the live-Azure
     constraint + screenshot substitute.

## Files Touched

- `tests/e2e/sprite-workflow-sensors.test.ts` — +1 parity test (now 4 tests).
- `docs/knowledge/handoffs/2026-06-26-pr2c-sensor-viz-force-judge.md` — guardrail
  detail (ADR lineage, degradation trace, DoD map).
- `docs/knowledge/handoffs/2026-06-26-pr2c-followup-parity-guardrails.md` — this
  handoff.

## Verification Run

- `npm run verify:fast` — ✅ (typecheck covers `tests/e2e`; eslint clean;
  `--changed` unit set had no changed unit files → pass-with-no-tests).
- `npx vitest run --project e2e tests/e2e/sprite-workflow-sensors.test.ts` —
  ✅ **4/4** (chromium headless), including the new parity test.
- Pre-push `format:check` — ✅ all files Prettier-clean.

## Unresolved Issues

None. The PR2 / 7-stage epic itself is already complete and merged via #347; this
follow-up only closes the post-merge review loop.

## Recommended Next Steps

- Land this follow-up PR (auto-merge `--squash`); hand to the shepherd.
- No further PR2-stack work remains. Future (out of scope): concurrency for re-run
  triggers (would make the atomic `put` load-bearing), and a stale-judge-sidecar
  sweep only if a judge-reset UI is ever added.

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` does not exist this session — nothing to paste.

## Key Decisions Made

No ADR — a test + documentation follow-up, no cross-system decision. The decision
of record is procedural: because #347 had already merged, these guardrail items
land as a separate small PR rather than as amendments to the merged epic PR.

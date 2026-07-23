# Session Handoff: Handoff-backed guard telemetry fallback

## Date

2026-06-21

## Persona(s) adopted

- Producer (cross-cutting telemetry/runtime/docs workflow change)
- DevOps Engineer (guard extension, docs automation, verification flow)

## Routing verdict

✅ right persona — this touched extension runtime, agent instructions, docs automation, and ADR/policy guidance.

## Apples

Estimated: 🍎 x 3
Actual: 🍎 x 3
Verdict: 🎯 Exact — the work stayed focused on one telemetry pipeline plus the cross-platform guard fix surfaced by validation.

Hello kitties: 3/5 = 0.60 🎀

## Systems touched

docs-tooling

## What Was Done

1. Extended `copilot-guards` telemetry to append every guard event to the session-local artifact `files/guard-telemetry.jsonl` while preserving the existing `session.log()` emission.
2. Added `scripts/agent/docs/guard-telemetry.ts` to:
   - render a handoff-ready telemetry block from the local JSONL artifact
   - analyze committed handoff telemetry summaries across recent sessions
3. Added focused tests for the new telemetry file append path and the handoff-summary parser/renderer.
4. Wired the telemetry analyzer into `docs-update.yml` and `npm run docs:check`, and updated handoff/instruction docs so future sessions paste the generated telemetry section into handoffs.
5. Fixed `shell-unsafe-port-kill` path normalization so Windows-style worktree paths are recognized correctly when tests run on Linux/cloud.

## What's Next

1. Future sessions should paste `npx tsx scripts/agent/docs/guard-telemetry.ts --handoff-section` into each handoff when `files/guard-telemetry.jsonl` exists.
2. After a few telemetry-bearing handoffs accumulate, review `docs-guard-telemetry` output for dead-guard candidates and coverage quality.

## Blockers

- None.

## Branch State

- Branch: `copilot/chronicle-agent-os-telemetry-report`
- All tests passing: yes
- PR created: no

## Agent-OS Telemetry

Guard telemetry artifact: `files/guard-telemetry.jsonl`

_Telemetry summary omitted from this historical handoff because the previously pasted sample was fixture data, not session capture._

## Test Results

- `node --test ".github/extensions/copilot-guards/tests/*.test.mjs"` ✅
- `npx vitest run tests/unit/guard-telemetry.test.ts` ✅
- `npx tsx scripts/agent/docs/guard-telemetry.ts --handoff-section` ✅
- `npx tsx scripts/agent/docs/guard-telemetry.ts` ✅ (warns that older handoffs do not yet contain telemetry summaries)
- `npm run verify:fast` ✅
- `npm run verify` ✅

## Key Decisions Made

1. Made handoffs the durable cross-session telemetry store, because repo commits survive across both desktop and cloud sessions while Chronicle queryability is currently unreliable.
2. Kept the runtime artifact local (`files/guard-telemetry.jsonl`) so telemetry capture does not dirty the branch unless the agent intentionally summarizes it into the handoff.
3. Fixed the Windows-path normalization bug in `shell-unsafe-port-kill` rather than ignoring the failing suite, since desktop/cloud path mismatches are directly relevant to this telemetry portability work.

# Session Handoff: Incremental Change Discipline for Headless-Gated Systems

## Date

2026-06-26

## Persona(s) adopted

Producer — this was a coordinated docs-only slice of a 4-part retrospective
initiative (fix #2 of 4), routed to no specialist because it is a single policy
edit with no code/layer impact.

## Routing verdict

✅ right persona — a cross-cutting policy/discipline change with no specialist
row in the routing matrix is exactly the Producer's lane.

## Apples

Estimated: 🍎 x 1 <!-- declared before work began -->
Actual: 🍎 x 1 <!-- honest assessment at handoff time -->
Verdict: 🎯 Exact — single-doc policy section plus required handoff + apple file, no surprises.

Hello kitties: 1/5 = 0.20 🎀

## What Was Done

Codified the missing **written discipline** half of the retrospective theme "a
fix caused a new regression because too much changed at once." The deterministic
**gate** half was already complete (`tests/headless/floor1-completion.test.ts`
already runs the canonical seed × weapon matrix `[15, 3, 7, 5]` × `[sword, bow,
baseball-bat]` and already has both a deterministic game-time budget assertion
and a coarse wall-time perf-regression guard, `HEADLESS_WALL_TIME_BUDGET_MS`).
No test was touched.

Added an **`## Incremental Change Discipline`** section to
`docs/agent-os/policies/ci-policy.md` (chosen over `lab-gate-policy.md` as the
clearly better home: the headless gate is a CI gate, and `ci-policy.md` is the
canonical CI-gate + determinism document — its existing "Core Principles",
"Agent Responsibility for Failures", and "Non-Negotiable" sections are the
natural neighbours; `lab-gate-policy.md` is narrowly about lab↔system existence
mapping). The section says:

- When changing **behavior** in a headless-gated system (AI / combat /
  pathfinding / floor progression), make **one behavioral change per commit** and
  re-run `npm run test:headless` after each.
- Do **not** batch behavioral changes into one commit — it makes a regression
  un-bisectable and forces a full revert instead of reverting just the offending
  change. Cites the swarm-kite revert (commit `28bfac4`, three AI behaviors in one
  commit, broke correctness + perf + stability at once) as the cautionary example.
- The gate asserts deterministic game-time correctness **and** a coarse wall-time
  perf guard across the seed × weapon matrix, so an over-broad change trips several
  assertions at once — isolate so the failing one is obvious.
- Keep it deterministic — no LLM-as-judge.

### Files touched

- `docs/agent-os/policies/ci-policy.md` — new `## Incremental Change Discipline`
  section (between "Agent Responsibility for Failures" and "Non-Negotiable").
- `docs/knowledge/handoffs/2026-06-26-incremental-change-discipline.md` — this handoff.
- `docs/knowledge/metrics/apples/2026-06-26-incremental-change-discipline.json` — apple metric.

## What's Next

The remaining fixes in the 4-part retrospective initiative (owned by sibling
sub-sessions). No follow-up is required for this slice.

## Blockers

None.

## Branch State

- Branch: `nalfeo-incremental-change-discipline`
- All tests passing: yes
- PR created: yes (see PR opened from this branch)

## Agent-OS Telemetry

N/A — no `files/guard-telemetry.jsonl` present this session.

## Test Results

- ✅ `npm run verify:fast`
- ✅ `npm run verify`

(Docs-only diff; the pr-preflight handoff gate auto-skips, but the repo handoff
rule still applies, so this file is written.)

## Key Decisions Made

- **Home = `ci-policy.md`, not `lab-gate-policy.md`.** The discipline governs a
  CI gate (headless) and reinforces the deterministic-CI principle, both of which
  `ci-policy.md` already owns; placing behavioral-change-isolation guidance in the
  lab-existence policy would be a topic mismatch.
- **Scope held to one doc + handoff + apple file.** Per the initiative's own
  lesson, kept this change minimal and isolated; did not touch AGENTS.md, any
  persona, or any test (each owned/complete elsewhere).

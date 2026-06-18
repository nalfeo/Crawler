# Session Handoff: Agent persona build-vs-buy policy update

## Date

2026-06-18

## Persona(s) adopted

**Producer** — this was a cross-persona documentation change to align role
constraints and routing guidance around one policy.

## Routing verdict

✅ right persona — the request spanned multiple persona docs plus routing/index guidance.

## Apples

Estimated: 🍎 x 2 <!-- declared before work began -->
Actual: 🍎 x 2 <!-- honest assessment at handoff time -->
Verdict: 🎯 Exact — N/A

Hello kitties: 2/5 = 0.40 🎀 <!-- actual_apples / 5, two decimal places -->

## What Was Done

- Added a shared build-vs-buy default to `docs/agent-os/personas/README.md`
  stating that fundamental game systems should evaluate off-the-shelf,
  industry-standard libraries/frameworks first.
- Added explicit constraints in these personas to enforce the same behavior:
  `producer.md`, `systems-engineer.md`, `game-designer.md`,
  `content-designer.md`, `ai-content-engineer.md`, `devops-engineer.md`,
  `qa-engineer.md`, and `reviewer.md`.
- Framed custom implementations as requiring explicit fit-gap rationale
  (determinism/performance/licensing/integration/maintenance as applicable).

## What's Next

- If desired, add a deterministic docs check that validates each persona keeps a
  build-vs-buy rule so this policy cannot drift.

## Blockers

None.

## Branch State

- Branch: `nalfeo/update-agent-personas`
- All tests passing: yes
- PR created: no

## Test Results

- `npm run verify:fast` → pass.

## Key Decisions Made

- Implemented policy at two levels: a shared top-level statement in
  `personas/README.md` and enforceable per-persona constraints where decisions
  are made or reviewed.

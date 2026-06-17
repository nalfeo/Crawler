# Session Handoff: Agent persona system — routing, orchestrator, content & reviewer roles

## Date

2026-06-17

## Apples

Estimated: 🍎 x 2 <!-- declared before work began -->
Actual: 🍎 x 2
Verdict: 🎯 Exact — documentation-only across several persona files plus a routing
README, two instruction edits, and a non-blocking preflight hint; no code/tests.

Hello kitties: 2/5 = 0.40 🎀

## What Was Done

Implemented the agreed plan (A–F) to fix gaps in the agent persona system:

- **E — Routing (highest leverage).** Added `docs/agent-os/personas/README.md`
  with a path/task → persona routing matrix, a Game/Content/Systems boundary
  quick-reference, a "conceptual agents" note (Director, Governor), and a persona
  index. Changed step 2 of both `AGENTS.md` and `.github/copilot-instructions.md`
  from "read your assigned persona" to "**select** your persona from the routing
  matrix (default to Producer for multi-layer/ambiguous), then read it."
- **A — Game Designer grounding.** Added a "Design DNA & Guardrails" section that
  names the GDD inspirations (Vampire Survivors, Brotato, Halls of Torment, DRG
  Survivor, Hades, **Dungeon Crawler Carl**) and binds each to a measurable target,
  plus a "dopamine ledger" rule. Cross-links the GDD and Lore Bible.
- **B — Producer persona** (`producer.md`): the orchestrator that decomposes work,
  routes slices to specialists, owns the apple estimate/scope, and produces one
  coordinating handoff. This is the home for "invoked at the right time."
- **C — Content Designer persona** (`content-designer.md`): owns authored floor/
  quest/encounter content as validated data (quest packs, floor objective ticks,
  map-gen tuning), with explicit boundaries vs Game Designer / Systems Engineer /
  Story Designer / AI Content Engineer.
- **D — Reviewer persona** (`reviewer.md`): high-signal, repo-specific review that
  augments (not duplicates) `parallel_validation`, `security-review.yml`,
  `nightly-mutation.yml`, and `coverage-gap-copilot.yml`. Enforces determinism,
  layer boundaries, lab-gating, AI safety, Zero-Cruft, and apple-scope creep.
- **F — Cleanups.** Promoted The Director (AI Content Engineer + Story Designer)
  and The Governor (QA Engineer) from prose mentions to named sections, and added
  a "Collaborates with" line to every persona.
- **Preflight hint.** Added a non-blocking, LLM-free persona-routing hint to
  `scripts/agent/preflight.sh` that suggests a persona from changed paths
  (best-effort; never fails preflight; keeps CI deterministic).

## What's Next

- Optional: a deterministic doc-lint that asserts every persona file has the
  expected sections (Responsibilities/Constraints/Quality Criteria/Collaborates
  with) and appears in the README index, so the matrix can't drift.
- Optional: wire CODEOWNERS path globs to mirror the persona routing matrix.

## Blockers

None.

## Branch State

- Branch: `copilot/review-agent-structure`
- All tests passing: yes (docs-only change; see below)
- PR created: no

## Test Results

- `bash -n scripts/agent/preflight.sh` → syntax OK; shellcheck clean.
- `npx prettier --check` on all changed markdown + instruction files → all pass.
- `npm run docs:check` → 0 blocking findings (path checker 0 findings; readme/
  archive INFO findings are pre-existing and unrelated).

## Key Decisions Made

- Routing lives in a single `personas/README.md` matrix and is the canonical
  entry point referenced by both instruction files (single source of truth).
- Producer is the explicit default for multi-layer/ambiguous work.
- Content Designer is a distinct role from Game Designer: it composes mechanics
  into floors via authored data, rather than owning mechanics/tuning.
- The preflight persona hint is informational only to preserve deterministic CI.

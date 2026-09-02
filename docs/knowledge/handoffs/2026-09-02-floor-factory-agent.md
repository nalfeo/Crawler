# Session Handoff: Floor Factory epic-planning agent

## Date

2026-09-02

## Persona

Producer

## Systems touched

agent-personas, docs-tooling

## Apples

Estimated: 3🍎; actual: 3🍎 — exact.

## Summary

Implemented issue "Create Floor Factory agent for end-to-end floor epic
planning" (closes nalfeo/Crawler#4096).

Added a new **specialist sibling agent** under the existing Producer persona
(same pattern as `perf-optimizer`/`docs-update`/`pr-shepherd`) rather than a
new persona/routing row, per the issue's "linked to the appropriate existing
persona doctrine without duplicating canonical policy" requirement:

- `.github/agents/floor-factory.agent.md` — the agent doc. Its only authored
  product for a floor request is
  `docs/knowledge/epics/<epic-id>/<epic-id>.epic.json`. Documents the hard
  gate (schema-valid/acyclic, progressive playability, config-driven
  composition, dual-runner spawn-to-win proof before release), the workflow
  steps, the floor-specific additive epic fields (`hard_gate`, `non_goals`,
  `human_gates`, `human_approved_exception_reason`), the per-node
  `Owner: <Persona>.` convention (already used informally in
  `floor-3-ai-runner-completion.epic.json`), and the Floors 1–6 regression
  lessons from the issue.
- Wired into the persona system: `docs/agent-os/personas/routing.json`
  siblings, `producer.md`'s `## Agent` section, and the README's Agent Index
  table. `npm run docs:check` (`check-personas`) passes.
- `scripts/agent/epics/floor-epic-lint.ts` — a deterministic linter making the
  doctrine's hard gate checkable rather than only prose. It layers
  floor-specific checks (hard-gate language, non-goals, HUMAN_GATE deferrals,
  node owner tags, no floor-ID branch smell, config-driven composition
  mention, a dual-runner proof node, a single terminal release/MVP slice, an
  eight-slice cap, progressive-playability-stage language) on top of the
  **existing, reused** generic schema/DAG validator
  (`validateEpicFile`/`topoSortNodes` in
  `.github/scripts/epics/epic-create.mjs`) instead of reimplementing it.
  Exposed as `npm run epics:lint-floor -- <path>`.
- `tests/unit/agent/floor-epic-lint.test.ts` — a representative "good" fixture
  (positive control, zero violations) plus one mutated regression fixture per
  mandatory invariant, each asserting the linter flags exactly that omission
  (acceptance criterion 4). Fixtures live under `tests/`, not
  `docs/knowledge/epics/`, so they are never picked up by the real
  `epic-create.yml` push-to-`main` trigger.
- Documented the new script in `AGENTS.md`'s command table (kept
  `docs-check-readme-commands` clean).

## Design note: dropped one initially-planned check

I initially added a `release-slice-not-gated-on-proof` check (the terminal
release node must depend, directly or transitively, on the dual-runner proof
node). Testing it revealed the check was unreachable dead code: in a DAG with
exactly one terminal node, every other node is necessarily that terminal's
transitive ancestor (a second, disconnected sink would itself trip the
already-present `release-slice-not-unique-terminal` check first). Removed the
redundant check and replaced its regression test with a positive-control test
documenting the property instead of asserting on dead code.

## Verification

- `npx tsc -p tsconfig.json --noEmit` — clean (including the new ambient-free
  dynamic-import typing for the reused `.mjs` schema validator).
- `npx eslint scripts/agent/epics/floor-epic-lint.ts
tests/unit/agent/floor-epic-lint.test.ts` — clean.
- `npx vitest run tests/unit/agent/floor-epic-lint.test.ts` — 21/21 passed.
- `npm run docs:check` — 0 blocking (check-personas: 0 findings).
- `npm run verify:fast` — 807 test files / 11382 tests passed; all data
  contract/integrity/coverage checks passed.
- `npm run verify:pr-prereqs` — passed after adding this handoff.
- Secret scan on touched files — no secrets detected.

## Unresolved issues / follow-ups

- The linter is pattern/keyword-based by design (deterministic, no LLM
  judge), matching this repo's existing convention of source-string unit
  tests for wiring (see `tests/unit/ai-runner-lighting-controls.test.ts`).
  It cannot verify that a plan's _content_ is factually correct against the
  live codebase (e.g. that a named manifest/system actually exists) — that
  still requires the agent (or a reviewer) to have actually inspected the
  repository per the workflow steps in the agent doc.
- No real floor epic was authored by this session; this issue was scoped to
  building the reusable agent/gate, not planning a specific floor.

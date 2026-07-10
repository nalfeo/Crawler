---
title: Conventions and Invariants
type: note
permalink: conventions-and-invariants
tags: [conventions, rules, ci]
---

# Conventions and Invariants

Hard rules that every change must respect. Several are enforced at the tool-call
boundary by the `copilot-guards` extension and in CI.

## Observations

- [invariant] All game randomness uses SeededRandom from src/shared/random.ts; never Math.random() #determinism
- [invariant] Never use Date.now() in game logic; pass delta or frameCount as parameters #determinism
- [invariant] No Phaser imports in src/core #layers
- [rule] Every new ECS system must have a lab in src/labs; enforced by scripts/agent/lab-gate-check.sh #lab-gating
- [rule] Conventional commits enforced by commitlint: feat, fix, chore, docs, lab, refactor, test, perf, ci, build, revert #commits
- [test] Use createTestWorld from tests/helpers/world-factory.ts; never construct worlds manually #testing
- [test] Unit tests for pure functions; property-based tests with fast-check for invariants; integration tests for pipelines #testing
- [workflow] Run npm run verify:fast after every change (~30s); npm run verify before committing (~3min) #workflow
- [process] Write a handoff at docs/knowledge/handoffs/YYYY-MM-DD-slug.md before ending a session #handoff
- [process] Declare a 1-5 apple complexity estimate before coding; record actuals via docs/knowledge/metrics/apples/YYYY-MM-DD-slug.json for ≥3🍎 sessions (1–2🍎 sessions do not require a file) #apples
- [merge] Authorized merges use: gh pr merge --auto --squash; no approving human review is required #merge

## Relations

- governs [[Architecture and Layers]]
- governs [[Systems Map]]
- applies_to [[Crawler Project Overview]]

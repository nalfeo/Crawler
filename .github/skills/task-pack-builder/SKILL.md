---
name: task-pack-builder
description: >-
  Turn merged Crawler PRs into replayable benchmark tasks with frozen test verifiers, for
  use by the velocity A/B lab. Use when asked to "build a task pack", "make benchmark
  tasks", "create replay tasks from PRs", "add a task to the velocity lab", or when an
  experiment needs tasks to run against. Extracts the PR's own tests as the pass condition,
  hashes them, and validates that every task is genuinely fail-to-pass at its base commit.
---

# Task pack builder

An A/B experiment is only as trustworthy as its tasks. This skill builds tasks the way
SWE-bench does: **replay a real merged PR**.

- Start state = the merge commit's **first parent** (the repo exactly as it was).
- Goal = the PR title.
- Pass condition = the PR's **own test files**, restored into the start state and frozen.

That last part is what makes the measurement honest. The verifier is written by the
original author for the original change, before any arm of any experiment existed — so no
arm can be tuned to it.

## How to run

```bash
# Build
npm run velocity:pack -- build --prs 1799,1812,1830 --id floor1-tuning

# Structural + hash validation
npm run velocity:pack -- validate --pack docs/knowledge/metrics/velocity/packs/floor1-tuning.json

# Fail-to-pass validation (slower — materialises each task's workspace)
npm run velocity:pack -- verify-base --pack docs/knowledge/metrics/velocity/packs/floor1-tuning.json
```

Packs are written to `docs/knowledge/metrics/velocity/packs/<id>.json`.

## Picking PRs

Good replay candidates:

- Changed **source and tests together** — the tests are the verifier, so a PR without them
  is unusable.
- Tests live in **one vitest project** (`unit`, `integration`, `headless`, …). A verifier
  spanning projects would silently run only part of itself, so the builder refuses it.
- **Self-contained**: no migration, no asset regeneration, no dependency bump.
- Representative of the work you actually want to speed up. A pack of trivial PRs will
  show that nothing matters.

The builder automatically drops `docs/**` from the recorded solution files — handoffs and
review ledgers are not part of the engineering work being replayed.

## Validation gates

`verify-base` is the important one. It builds each task's real workspace and asserts the
verifier **fails**. A verifier that already passes at the base commit means the tests do
not cover the change, and every trial would score a free win — the task measures nothing
and must be removed.

## Guardrails

- **Never hand-edit a pack's `verifierFiles` or `verifierHash`.** The hash exists so that
  a tampered verifier is detectable; editing it defeats the entire design. Rebuild instead.
- **Never add a task after seeing experiment results.** Choosing tasks that flatter a
  hypothesis is the most natural and most invalidating thing you can do here. Freeze the
  pack, then run.
- Packs are committed so results are reproducible. Keep them small and named for intent.
- A task's prompt must never mention the PR number or the solution SHA — the lab audits
  transcripts for both, and a leak invalidates the trial.

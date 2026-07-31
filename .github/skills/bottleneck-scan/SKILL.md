---
name: bottleneck-scan
description: >-
  Find where Crawler feature delivery actually loses time, using merged-PR history plus
  committed apple and guard-telemetry metrics. Use when asked to "find the bottleneck",
  "why is delivery slow", "where is time going", "scan for process friction", "what
  should we fix to ship faster", or as the first step of any velocity investigation.
  Reports queue-vs-active time per stage, cycle time by change size, estimation accuracy,
  guard deny-rates, and an open-PR aging panel that surfaces active stalls while they are
  happening — deterministic, no LLM judging, no new infrastructure.
---

# Bottleneck scan

Answers: **where does a Crawler change spend its life, and which part of that is queueing
rather than working?**

Time spent waiting is the cheapest thing to remove — it costs nobody any thinking. So the
scan separates every merged PR's lifetime into stages and labels each stage `QUEUE` or
`ACTIVE`.

It also surfaces **stalls while they are happening** via an open-PR aging panel, avoiding
the survivorship bias of merged-PR-only analysis.

## How to run

```bash
npm run velocity:scan -- --limit 60
```

Options:

| Flag        | Meaning                                         |
| ----------- | ----------------------------------------------- |
| `--limit N` | How many recent merged PRs to mine (default 50) |
| `--out P`   | Write the JSON report to `P` as well as stdout  |

Requires `gh` to be authenticated. Runs in well under two minutes and writes nothing to
the repo unless you pass `--out`.

## What it measures

**Stage model** (adapted from Apache DevLake's value-stream decomposition):

| Stage                      | Kind     | What a big number means                             |
| -------------------------- | -------- | --------------------------------------------------- |
| `open → first review`      | `QUEUE`  | Review capacity or triggering is the constraint     |
| `first review → last push` | `ACTIVE` | Rework loop — review finds a lot, or fixes are slow |
| `last push → merge`        | `QUEUE`  | CI duration or merge-gate contention                |

**Cycle time by size bucket** (≤100 / 101–500 / 501–2000 / >2000 lines of churn).
A sharply super-linear curve says the constraint is _batch size_, and the fix is
decomposition, not tooling.

**Estimation accuracy** from `docs/knowledge/metrics/apples/*.json` — systematic
under-estimation predicts scope surprises, which are usually a design-clarity problem.

**Guard friction** from `docs/knowledge/metrics/guard-telemetry/*.json` — per-guard
allow/deny counts, skipping `quarantined: true` sessions. A guard with a high deny rate is
either catching a real recurring mistake (good — automate the fix) or is mis-scoped (bad —
it is a tax).

**Open-PR aging panel** — measures the _currently open_ PRs, not just merged history:

| Field             | Meaning                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------- |
| `p50 / p90 / max` | Age distribution of all open PRs in hours                                               |
| `countAbove4H`    | Number of open PRs older than 4 hours — the first-alert threshold                       |
| `labelBreakdown`  | Count of PRs carrying each known blocking label (`ci-conflict-order-wait`, etc.)        |
| `oldest`          | The 5 oldest open PRs with total age, idle time (from `updatedAt`), and blocking labels |

When `maxAgeH ≥ 24`, the panel emits a `⚠ STALL ALARM` in both the rendered output and
the findings list. A 64-hour stall with 18 PRs blocked by `ci-conflict-order-wait` will
produce an unmissable alarm — this is the scenario that motivated the panel.

## Reading the report

Findings are ranked by estimated recoverable time. For each one, ask the only question that
matters next: **what is the smallest change that would move this number, and can I A/B it?**

A finding is not a mandate. Take the top finding into `task-pack-builder` +
`velocity-lab` and prove the fix works before landing it.

## Guardrails

- The scan is **observational**. It shows correlation over a small, self-selected sample.
  It cannot tell you that a change _caused_ an improvement — only an A/B can.
- Mind the denominator. A stage that is slow on 3 PRs out of 60 is an anecdote.
- Recent-PR bias is real: a policy that changed 20 PRs ago pollutes the window. Prefer
  comparing two explicit windows over trusting one aggregate.
- The open-PR aging panel uses `updatedAt` as an inactivity / idle-time metric. This is
  intentionally not "time in current state" — label assignment timestamps would require
  timeline events.

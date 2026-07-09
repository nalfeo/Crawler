# Session Handoff: Cloud-parallel AI combo × hill-climb eval pipeline

## Date

2026-07-09

## Persona

Producer (session-level orchestrator)

## Systems touched

ai-combat-balance

## Apples

4🍎 estimated, 4🍎 actual (✅ hit). Multi-file tooling + a GitHub Actions
pipeline + a paranoid fan-in trust boundary; adversarial plan review produced a
`major_fork`, and the code-review loop caught 6 real integrity concerns across 2
rounds. Full 4🍎 review harness recorded in
`docs/knowledge/review-ledgers/2026-07-09-ai-sweep-eval-pipeline.review-ledger.json`.

## What Was Done

Built the **measurement-only** eval mechanism the maintainer asked for: a
cloud-parallel campaign that (1) evaluates every **pathing × decision combo**
(4 pathing × 2 decision = **8 combos**), (2) **hill-climbs the most important
`AIConfig` knobs** within each combo via in-process coordinate-ascent, and (3)
produces a leaderboard ranked by **total composite score across 3 weapons × 100
seeds (300 runs)**. The pipeline **only measures** — it never flips a default.
The actual default-flip away from `LEGACY` stays a **separate human-gated step
(S5)**.

- **`scripts/agent/perf/gen-configs.ts`** (pure) — enumerates the 8 combos,
  defines `KNOB_RANGES`/`PRIMARY_KNOBS` from the real SSOT config, and produces
  per-combo neighbor configs (`configId`, `neighbors`, `baseConfigForCombo`) for
  coordinate-ascent.
- **`scripts/agent/perf/sweep-eval.ts`** (runner) — `search`/`validate` stages;
  runs headless Floor-1 via a tsx worker pool; reduces each run to a scored,
  win-classified row through the shared `deriveRunFacts` helper; emits a
  provenance-stamped shard artifact.
- **`scripts/agent/perf/aggregate-shards.ts`** (pure fan-in trust boundary) —
  merges shards, rejects mixed provenance / config-id collisions / incomplete
  matrices, **recomputes** `officialWin` + `score` from raw row facts
  (`assertRowsConsistent`) so a tampered/self-reported row cannot inflate the
  leaderboard, then builds the multi-column leaderboard.
- **`.github/workflows/ai-sweep.yml`** — dispatch-only (`workflow_dispatch`,
  `contents: read`), injection-safe (user inputs via `env:`), 4 jobs
  (preflight → search → validate → aggregate), combo job-matrix capped ≤200,
  cheap-screen defaults with documented full graduation values.
- **`scripts/agent/perf/winrate-sweep-args.ts`** — hardened the shared int/seed
  parsers (blank/whitespace no longer coerces to a silent `0`; `parseSeeds`
  rejects empty CSV segments and blank range endpoints). Fixes a round-2 High:
  a malformed `workflow_dispatch` seed input (e.g. `1,,80`) would have silently
  injected seed `0` and skewed the panel.
- **`package.json`** — 3 `ai:*` scripts (`ai:gen-configs`, `ai:sweep-eval`,
  `ai:aggregate-shards`).
- Tests: `tests/unit/ai/sweep-gen-configs.test.ts`,
  `tests/unit/ai/sweep-aggregate-shards.test.ts` (locks the anti-tamper
  invariants: rejects fake-win + inflated-score rows, provenance mismatches,
  config collisions), and regression tests in
  `tests/unit/winrate-sweep-args.test.ts` for the blank-segment fix.

## Verification Run

- `npm run verify:fast` — GREEN (typecheck + lint changed files + 77 unit tests
  across the 3 changed test files).
- `npm run verify` — GREEN through all local steps: typecheck, lint, format,
  guards, unit (61 files), integration (1154 tests), sprite pipeline; **PR
  prereqs** pass (valid 4🍎 ledger + handoff). The ~306s **Headless Floor-1 gate
  is deferred to its required CI job** (this diff is provably sim-neutral tooling
  — it imports game code but modifies none of `src/core` / `src/game/ai` /
  balance data — so the sim is byte-identical; CI still enforces the gate on this
  `gameplay_safe=false`-classified PR before the armed merge completes).
- `npm run review:ledger -- validate <path>` — exit 0 (valid 4-apple ledger).

## Observe Before Done (rule #10)

This is **measurement tooling**, not a runtime/behavior change — no `*System`
added, no lab/wiring obligation. Observed the three CLIs behave in the **real**
artifact:

- `ai:sweep-eval` ran a **real headless Floor-1** run (seed 1, sword → victory,
  score 1004355) and the tsx worker pool produced deterministic rows.
- `ai:aggregate-shards` unit tests directly observe the trust boundary **reject**
  a fake-win row and an inflated-score row, and **accept** score-consistent rows.
- Direct `tsx` smoke confirmed the parser fix: `1,` / `,2` / `1,,3` / `1-` /
  blank `--rounds` all throw loudly; valid `1-3` still expands to `[1,2,3]`.

The pipeline keeps both pathing and decision defaults `LEGACY` (byte-identical on
main) — it produces the numbers a human uses to decide a flip; it never flips.

## Review Harness (4🍎)

- **plan_review** — adversarial (gpt-5.4 xhigh), 3 alternatives, `major_fork`;
  REJECTED the original config×seed matrix; all 12 concerns (8 blocking) adopted
  (8-combo job matrix, TRAIN 1–80 / HOLDOUT 81–100 anti-leakage split, in-process
  coordinate-ascent, recompute-from-rows aggregator, dispatch-only workflow).
- **code_review** — round 1 (gpt-5.4 + gemini-3.1-pro + claude-sonnet-4.6): 5
  concerns, all fixed. Round 2 (gpt-5.4 + gemini-3.1-pro): confirmed the 5 fixes
  - cleared the float-roundtrip risk; 1 new High (blank seed segment) fixed.
    Terminal clean within the 2-round cap.
- **multi_model_review** — same models, adjudicator claude-opus-4.8; all concerns
  adjudicated valid + resolved. Clean.

## Unresolved / Next Steps

The tooling PR is the _mechanism_; the **actual eval campaign** is the next move
(after this merges to main so `ai-sweep.yml` is dispatchable):

1. **Stage-0 screen:** `gh workflow run ai-sweep.yml --ref main -f combos=all
-f rounds=0 -f train_seeds=1-24 -f validate_seeds=1-40` → real ubuntu wall
   time + all-8 baseline ranking + the `LEGACY` incumbent number. Recalibrate
   seeds/rounds from the measured wall time.
2. **Full graduation run:** `-f combos=all -f train_seeds=1-80 -f
validate_seeds=1-100 -f rounds=3` → assemble the S4 decision packet
   (leaderboard + divergence flags + win-loss flips) → present to the human for
   the **S5 default-flip** decision.
3. **Deferred (separate PR):** browser import-safety smoke test for the
   `src/game/ai` chain (jsdom/happy-dom can't reproduce; needs real-browser e2e
   or a process-stubbed dynamic-import harness). ~2🍎.
4. **Pre-existing balance note:** `LEGACY` Floor-1 win-rate is ~80–86% (< the 90%
   target) on main — a pre-existing property, not caused by this pipeline. Mode
   graduation (S5) is the intended lever to close that gap.

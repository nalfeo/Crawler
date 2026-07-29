# Handoff — 2026-06-26 pr2b-1-generate-decouple (PR2b-1)

## What Was Done

Second PR of the **PR2 stack** (after PR2a #323). Implements **Option B**
(ADR 0023 §5, now formalised in **ADR 0024**): the **Generate** stage produces
and stores the **raw sheet(s) ONLY** — no post-process, score, or judge.
PostProcess and Judge are the explicit, operator-driven steps PR2a already
serves via `POST /api/runs/:b/:r/postprocess` and `/judge`.

Stacked on PR2a branch `nalfeo-workflow-7-stage-restructure`. Apple estimate:
**🍎🍎🍎🍎 (Large)**; scored 4 at handoff (see metrics file).

**NOT in this PR** (later, do not start here): the 7-stage state-machine rewrite
(`src/devtools/sprite-workflow-queue.ts`), the devtools UI restructure, and
dropping Promote → **PR2b-2** (stacks on this). Per-sensor rendering + force-judge
button → **PR2c** (PR2a already landed the data + `force` backend).

## Design (the seam)

`generateOne` was a coupled orchestrator (generate → slice → postprocess →
score → judge → full summary). Split into three named entry points:

- **`generateSheetCore`** (`generate-one.ts`, exported internal core): load +
  expand brief → build prompt → provider (bounded retries) → store
  `sheet-NN.png` → **slice as a quality GATE only** (`cells.length ===
variantCount(brief)`, retry generation on a bad grid). Writes **no
  `summary.json`**. Returns the gate-validated `sliced` cells + resolved inputs
  (`brief`, `palette`, `referencePngs`, `styleGuide`, `identity`).
- **`generateOne`** (exported, GENERATE-ONLY): `generateSheetCore` + write a
  **minimal** sheet-only summary (`candidates: []`, `diversity/chosen/judge*:
null`, recomputed `variantCount`, identity + variations). Discards the gate's
  sliced cells. → sidecar `/api/workflow/generate` (noop path) + `worker.ts`.
- **`runFull`** (`run-full.ts`, NEW): `generateSheetCore` (reusing its sliced
  cells) + PR2a's `run-pipeline.ts` helpers (`postprocessScoreAndStoreVariant`,
  `runJudgePass({ judgeEnabled: brief.judge.enabled })`, `assembleSummaryEntries`)
  - rank/diversity/chosen + full summary. → CLI `sprites:run` + `batch.ts`.

`runFull` reuses the **same** `run-pipeline.ts` path the re-run endpoints use, so
a one-shot run and an explicit generate→postprocess→judge sequence produce
byte-identical artifacts (ADR 0018 one-path discipline — **no forked
postprocess**).

## Consumer rewire

| Consumer                                | Before               | After                      |
| --------------------------------------- | -------------------- | -------------------------- |
| sidecar `/api/workflow/generate` (noop) | `generateOne` (full) | `generateOne` (sheet-only) |
| `worker.ts` (queue/devtools Generate)   | `generateOne` (full) | `generateOne` (sheet-only) |
| `cli.ts runOne` (`sprites:run`)         | `generateOne` (full) | `runFull`                  |
| `batch.ts` (`generate` seam default)    | `generateOne`        | `runFull`                  |

`GenerateOneOptions` lost the judge-only fields (`visionProvider`, `judgeBudget`,
`judgeCache`, `env`) → moved to `RunFullOptions`. `textProvider` stays (variation
expansion is part of Generate). The worker is the real Generate path, so it goes
sheet-only and the now-unused **vision-provider plumbing was removed** from
`worker.ts`, `worker-controller.ts`, `worker-cli.ts` (the worker no longer
judges — removing the wiring is honest, not dead code).

## `rerun.ts` carry-forward guard (PR2a review)

`repostprocessRun` rebuilt candidates from the re-sliced sheet but blindly
carried `summary.variantCount` via `...prior`. Added: compute `expected =
variantCount(brief)`; throw new `RerunError('variant-count-mismatch')` (→ HTTP
**422**, added to `rerunErrorStatus`) when `sliced.length !== expected`, and
**write the recomputed** `variantCount: expected` into the rewritten summary.
Mirrors Generate's gate. `writeRunSummary` patch gained an optional
`variantCount`; `rejudgeRun` omits it (keeps prior — judging doesn't re-slice).

## Test / fixture changes — each justified

- **`tests/integration/generate-one.test.ts`** → reworked to the **sheet-only
  contract**. New test asserts `sheet-00.png` + minimal summary
  (`candidates: []`, null judge/diversity/chosen, `variantCount: 4`, NO
  `processed/` or `raw/` dirs). **Retry-gate tests stay** (bad-grid retry,
  non-retryable auth, exhaust maxAttempts) — the retry test's
  `candidates.toHaveLength(4)` became `candidates.toEqual([])` + assert
  `sheet-01.png` (the gate fires but Generate stores no candidates). Dropped the
  full-pipeline + ranking assertions (they no longer describe Generate). _Why:_
  Generate's contract changed; these are now the correct assertions for it.
- **`tests/integration/run-full.test.ts`** (NEW) → the moved full-pipeline +
  ranking assertions (candidates ranked, processed/scorecard/anchor-overlay
  artifacts, pipeline manifests), now driven by `runFull`. _Why:_ those
  assertions describe the one-shot full pipeline, which is now `runFull`, not
  `generateOne`. Relocated verbatim so coverage is preserved, not lost.
- **`tests/integration/judge-pipeline.test.ts`**, **`judge-budget-cache.test.ts`**,
  **`synth-to-generate.test.ts`**, **`batch-cli.test.ts`** → repoint
  `generate-one.js`/`generateOne` → `run-full.js`/`runFull`. Assertions
  unchanged. _Why:_ judging + the one-shot seam now run through `runFull`; only
  the entry point moved.
- **`tests/unit/sprites/batch.test.ts`** → `GenerateOneFactory` → `RunFullFactory`,
  describe title `generateOne recording` → `runFull recording`. _Why:_ the batch
  seam's injected factory type was renamed with the entry point.
- **`tests/unit/sprites/worker-controller.test.ts`** → dropped
  `createVisionProvider: () => null` from `baseDeps`. _Why:_ the worker no longer
  builds a vision provider (sheet-only Generate); the dep was removed.
- **`tests/fixtures/sprites/seed-run.ts`** → seeds via `runFull` (was
  `generateOne`). _Why:_ `rerun.test.ts` / `sidecar-rerun.test.ts` need a run
  WITH processed artifacts + candidates to re-process/judge; only `runFull`
  produces those now. (Already on `runFull` from the prior session segment.)
- **`tests/integration/sprites/rerun.test.ts`** → **added** a
  `variant-count-mismatch` test: seed a 2×2 (4-cell) run, widen the brief to 2×3
  (`variantCount` 6), call `repostprocessRun` → expect
  `RerunError('variant-count-mismatch')`. _Why:_ covers the new guard. The grid
  lever works because slicing is content-aware (ADR 0018) — it ignores
  rows/cols and still recovers 4 cells from the stored sheet, while
  `variantCount` = rows×cols − empty = 6.
- **`sidecar-server.test.ts`** generate tests (validation/enqueue/404) →
  **unaffected**, pass unchanged.

## Interim state (expected, mid-stack)

After sheet-only Generate, the devtools Generate button yields a run with 0
candidates (`applyGeneratedRunToQueue` sees `candidates: []`). **This is the
expected mid-stack state; PR2b-2 rewires the devtools UI.** `verify.sh` runs
unit/integration/headless (NO Playwright E2E), so it stays green.

Also: the sheet-only summary uses the `...identity` spread, so its JSON **key
order** differs (variations precedes candidates). All readers parse by field
name (`toEqual`/`JSON.parse`) — inert, but a raw-string snapshot of
`summary.json` would notice. None exists.

## Validation

- `npm run verify` → **GREEN** (all 8 steps; 1963 unit + integration + headless
  - build). NOTE: a first verify run hit 4× 30s timeouts in the CPU-heavy,
    untouched `score-candidate.test.ts` purely from CPU contention (I had parallel
    test shells running); re-running with nothing else competing was fully green,
    and that file passes in isolation in ~19s. No logic issue.
- `npm run verify:fast` → green. `bash scripts/agent/lab-gate-check.sh` → green
  (no new ECS systems; sidecar/scripts only).

## Stacked-PR mechanics

Branch HEAD sat exactly on the PR2a tip (`562ac0c` =
origin/nalfeo-workflow-7-stage-restructure) before my commit, so a PR targeting
that branch diffs to **only** my PR2b-1 commit. GitHub auto-retargets to `main`
once PR2a (#323) merges. If #323 already merged, rebase onto `main`.

## Next (PR2b-2, do NOT start here)

7-stage pure state-machine rewrite of `src/devtools/sprite-workflow-queue.ts`,
devtools UI restructure to drive Generate→PostProcess→Judge as distinct stages
(consuming the now sheet-only Generate output), and dropping the Promote stage.

## Agent-OS Telemetry

Guard telemetry artifact: `files/guard-telemetry.jsonl`

```json
{
  "schema": "agent-os-guard-telemetry-summary/v1",
  "artifact": "files/guard-telemetry.jsonl",
  "events": 1,
  "guards": {
    "pr-preflight": {
      "allow": 1
    }
  },
  "tools": {
    "create_pull_request": 1
  }
}
```

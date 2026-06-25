# ADR 0023: Re-runnable PostProcess & Judge over stored sprite sheets

## Status

Accepted

## Date

2026-06-26

## Estimated Complexity

🍎 x 4 — multi-subsystem (new shared pipeline module + re-run orchestrator +
two sidecar endpoints + structured per-sensor results plumbed into the durable
devtools queue state + tests), ADR required, but no new ECS system and no new
lab (sidecar/devtools infra).

## Context

The sprite-generation workflow is moving from a 6-stage flow to a 7-stage one
(tracked across the PR2 stack):

```
old: Synthesize → Choose → Promote → Generate → Approve → Tag
new: Synthesize → Choose → Generate → PostProcess → Judge → Approve → Tag
```

The old **Generate** stage was monolithic: a single `generateOne` call
produced the raw sheet, sliced it, post-processed every variant, ran the VLM
judge, and wrote `summary.json` — all or nothing. If an operator wanted to
tweak a post-processing option (e.g. background tolerance) or re-judge with a
different gate, the **only** path was to regenerate the sheet from scratch.
That re-rolls the expensive image-model call and **discards the exact pixels
the operator was iterating on** — the sheet is the single most costly artifact
in the pipeline, and it was being thrown away to change a cheap downstream
step.

Two facts about the existing system made a cheaper path possible:

- Raw sheets are **already persisted durably**. `generateOne` writes
  `sheet-NN.png` for every attempt through the injected `RunStore`
  (`<briefId>/<runId>/sheet-NN.png`), local or Azure Blob (ADR 0017).
- Slicing is **already a single content-aware path** (ADR 0018):
  `sliceSheetFromBrief` is deterministic and shared by generation and the
  `/api/slice-map` debugger.

So the raw sheet can serve as a durable **source artifact** that PostProcess
and Judge re-derive from, without regeneration. The risk was divergence: if a
re-run used even slightly different post-processing or judge-gating code than a
fresh generation, a re-processed run would no longer match what generation (and
`approve`) would have produced — the exact class of bug ADR 0018 fixed for
slicing.

## Decision

**Extract the per-variant work `generateOne` did inline into one shared
pipeline module, and build PostProcess/Judge re-runs on top of it so a re-run
over a stored sheet reproduces generation-time artifacts byte-for-byte.**

### 1. Shared per-variant pipeline — `scripts/sprites/run-pipeline.ts`

The post-process → score → write-artifacts block and the gated VLM judge pass
were lifted verbatim out of `generateOne` into three exported helpers:

- `postprocessScoreAndStoreVariant` — post-process one raw cell, score it, and
  write every per-variant artifact (raw/processed PNG, scorecard,
  pipeline-step PNGs + index, anchor sidecars, anchor-overlay) through the
  store.
- `runJudgePass` — the gated judge pass. Eligibility is unchanged from
  generation (only sensor-passing variants, ranked by sensor score, capped at
  `brief.judge.maxVariants`), with two **new** parameters:
  - `force` — judge variants that **failed** their sensors (override the
    sensor gate); powers the "force judge" operator action.
  - `variantIndexes` — restrict judging to a subset so a partial re-judge can
    merge over prior verdicts.
- `assembleSummaryEntries` — fold each variant's sensor result and judge
  verdict into the final `RunSummaryEntry`, computing
  `combinedPassed = passed && (!judgeEnabled || judge.passed)` in one place.

`generateOne` now **consumes** these helpers (it shrank from 542 to 332 lines).
Behavioural equivalence is pinned by the pre-existing integration suites
(`generate-one.test.ts`, `judge-pipeline.test.ts`), which still pass unchanged.

### 2. Re-run orchestrator — `scripts/sprites/rerun.ts`

A new module re-derives a run's downstream artifacts from its stored sheet:

- `repostprocessRun` — re-slice the stored sheet (content-aware) and
  re-post-process + re-score every variant with tweakable `PostprocessOptions`,
  overwriting `processed/**` + `summary.json` **in place**. Judge verdicts are
  **reset** (the prior verdicts judged different pixels), so each candidate
  comes back with `judgeScorecard: null`, `judgeSkipReason: null`, and
  `combinedPassed` gated on sensors alone.
- `rejudgeRun` — re-run the judge over the stored `processed/NN.png` without
  touching pixels. Treats judging as enabled, supports `force` and
  `variantIndexes`, and **merges** new verdicts over the prior summary so an
  untouched variant keeps its existing verdict.

The module is deliberately **decoupled from the sidecar**: callers pass an
already-resolved `brief`/`palette` (plus references/style guide for judging)
and the loaded `RunSummary`, so every function is unit-testable against a
`LocalRunStore` tmp dir with no HTTP or brief-file IO. Errors are a typed
`RerunError` with a `kind` the sidecar maps to an HTTP status.

### 3. Sidecar endpoints — `scripts/sprites/sidecar/server.ts`

- `POST /api/runs/:briefId/:runId/postprocess` (body `{ options?, sheet? }`) —
  deterministic, so **CI-safe**.
- `POST /api/runs/:briefId/:runId/judge` (body `{ variantIndexes?, force? }`) —
  LLM-as-judge, so **refused in CI** (Constitutional §3, `403`) and `400` when
  no vision provider is configured.

Both share a `resolveRunForRerun` helper that mirrors the slice-map handler
(load `summary.json` → resolve the brief path) plus the generate handler's
re-materialisation of a checkpoint-wiped draft brief from the store.

Both endpoints return the full re-run `summary` (incl. each candidate's
`breakdown`), so the structured per-sensor results below ride the same response
the generate endpoint already returns.

### 4. Structured per-sensor results surfaced to the queue state

`wf-sensor-failure-visibility` ("show **which** sensors failed and why, per
variant, not just a pass/fail tally") and the `force`-judge gate are needed by
the same operator the re-run endpoints serve, so their **backend/data plumbing**
landed here rather than in the later UI PR.

The structured detail already existed end-to-end on the backend: each sensor
returns a `SensorResult` (`{ ok, sensor, reason?, pixels? }`), the scorer keeps
the full ordered list in `Scorecard.breakdown`, and `RunSummaryEntry.breakdown`
mirrors it into `summary.json`. The only gap was the **devtools frontend**,
which dropped `breakdown` when mapping the sidecar summary into its persisted
`QueueRunCandidate`. So:

- `QueueRunCandidate` gains a `sensors: QueueSensorResult[]` field
  (`{ sensor, ok, reason, pixelCount }`), and `sanitizeRunCandidate` parses it
  defensively (same posture as the judge summary) so it survives a
  serialize/refresh round-trip through the durable workflow-state.
- `devtools-main.ts` reads `breakdown` off the sidecar summary and normalises it
  into that shape at the single summary→candidate mapping site, so a fresh
  generate **and** every re-run populate `sensors` from day one.

No rendering is included — PR2c consumes `candidate.sensors` and the `force`
flag purely in the UI. Keeping the data structured from the first PR means the
UI PR adds no new sidecar/state surface area.

### 5. Generate stores only the raw sheet (Option B); PostProcess is the single explicit path

The product decision for the new flow (confirmed for the PR2b Generate refactor)
is **Option B**: the **Generate** stage produces and stores the raw sheet(s)
**only** — it does **not** post-process, score, or judge. The user-visible
**PostProcess** stage (slice → background-fix → resize → store final variants) is
an explicit, operator-driven step, and **Judge** follows it.

This sharpens the seam built in this ADR:

- Because nothing post-processes during Generate, `POST /api/runs/:b/:r/postprocess`
  is **THE** post-process path, not a "re-run of something Generate already did".
  The first PostProcess and every subsequent one are the **same idempotent,
  options-driven operation** over the stored sheet, returning structured
  per-sensor results. The endpoint shipped in this PR (PR2a) is already built
  this way, so it is correct under Option B with no change — it is option-agnostic
  by construction.
- **Bad-grid retry quality gate is preserved, but scoped.** Today `generateOne`
  slices the freshly generated sheet to assert `cells.length === variantCount(brief)`
  and **retries generation** on a bad grid. PR2b keeps a **lightweight,
  content-aware sliceability check inside Generate purely for that retry
  decision** (slicing is cheap and single-path since ADR 0018) — but Generate
  still stores only the raw sheet. That internal check is explicitly **not** the
  user-visible PostProcess: the fix/resize/store-final-variants work stays an
  explicit PostProcess click. Losing this gate would let malformed sheets through,
  so PR2b must retain it while moving the heavy per-variant work out of Generate.

Implementation of the Generate/PostProcess split lands in **PR2b** (the
`generateOne` split + the `/api/generate` endpoint and its integration fixtures,
which today assume the coupled pipeline). PR2a only provides the option-agnostic
re-run endpoints this split relies on.

## Consequences

### Positive

- PostProcess and Judge are re-runnable on the stored sheet **without
  regenerating** — the expensive image-model call is made once and the operator
  iterates on cheap downstream steps.
- Generation and re-run share **one code path** (`run-pipeline.ts`), so a
  re-post-process reproduces generation-time bytes exactly — the ADR 0018
  "one code path" discipline, now extended to post-processing and judging. A
  parity test asserts this byte-for-byte.
- `generateOne` is materially smaller and its per-variant logic is now
  independently unit-tested.
- `force` and per-subset `variantIndexes` give the Judge UI (PR2c) the
  primitives for "force judge past a failing sensor" and partial re-judge.
- Per-sensor failure detail is carried structured all the way into the durable
  queue state (`QueueRunCandidate.sensors`), so the PostProcess/Judge UI can show
  which sensors failed and why with **no** additional sidecar or state work in
  PR2c — that PR becomes pure rendering + E2E.

### Negative

- The raw sheet is now a long-lived source artifact that re-runs depend on. Runs
  whose sheets were pruned cannot be re-processed (the endpoints return
  `sheet-not-found` / `404`).
- `repostprocessRun` overwrites `processed/**` + `summary.json` in place — there
  is no history of prior post-process results for a run.

### Risks

- A re-judge needs the stored `processed/NN.png`; if PostProcess has not been
  run (or its artifacts were pruned) `rejudgeRun` throws `processed-missing`.
  The operator re-runs PostProcess first. This is surfaced as a typed error, not
  a crash.
- `repostprocessRun` resets judge verdicts to `judgeSkipReason: null` (meaning
  "post-processed, not yet judged"), which is a new state distinct from
  `judge-disabled`. Consumers that exhaustively switch on `JudgeSkipReason`
  should treat `null` as "no verdict yet". No new `RunSummary` fields were added,
  so existing serialization guards are unaffected.

## Alternatives Considered

- **Keep regeneration as the only path; just make it cheaper.** Rejected — it
  still re-rolls the image model and discards the pixels under iteration, which
  is the core problem.
- **Add a second "reprocess" implementation separate from generation.**
  Rejected — that reintroduces exactly the divergence ADR 0018 eliminated for
  slicing. Sharing `run-pipeline.ts` is what guarantees parity.
- **Persist a new `sheetFile`/judge-history field on `RunSummary`.** Deferred —
  adding fields risks breaking the serialization guards; the re-run preserves
  run identity and rewrites only the derived candidate/judge fields. Sheet
  selection defaults to the newest `sheet-NN.png` (matching `/api/slice-map`)
  with an explicit override in the request body.
- **Make the judge endpoint inject its vision provider for testing.** Deferred —
  the sidecar builds the provider from env via `createVisionProvider`; the judge
  happy-path is covered at the `rerun.ts` layer with a mock provider, and the
  endpoint tests pin the gates the sidecar owns (CI refusal, missing config,
  validation, run resolution).

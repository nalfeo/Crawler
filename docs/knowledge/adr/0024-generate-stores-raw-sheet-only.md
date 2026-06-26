# ADR 0024: Generate stores the raw sheet only (Option B); `runFull` for one-shot tools

## Status

Accepted

## Date

2026-06-26

## Estimated Complexity

🍎 x 4 — multi-module refactor across a seam PR2a already built (`generateOne`
split into a generate-only wrapper + a shared `generateSheetCore`), a new
one-shot `runFull` orchestrator, sidecar + worker rewire, a `rerun.ts`
correctness guard, ~8 test files reworked, and this ADR. No brand-new ECS system
and no new lab (sidecar/scripts infra); the per-variant pipeline already exists
in `run-pipeline.ts` (PR2a).

## Context

ADR 0023 §5 recorded the product decision for the 7-stage sprite workflow as
**Option B**: the **Generate** stage produces and stores the raw sheet(s)
**only** — it does not post-process, score, or judge. PostProcess and Judge are
explicit, operator-driven steps already served by PR2a's re-run endpoints
(`POST /api/runs/:b/:r/postprocess` and `/judge`). ADR 0023 built the
option-agnostic re-run path; it deferred the actual Generate/PostProcess split
to PR2b. **This ADR records that split (PR2b-1).**

The pre-split `generateOne` was a coupled orchestrator: generate sheet → slice →
post-process every variant → score → VLM judge → write a full `summary.json`.
Under Option B that is wrong for the queue/devtools Generate stage, which must
yield a sheet-only run and let the operator drive PostProcess/Judge explicitly.

Two constraints shaped the implementation:

- **The bad-grid retry quality gate must survive (ADR 0023 §5).** `generateOne`
  slices the freshly generated sheet to assert `cells.length === variantCount(brief)`
  and **retries generation** on a bad grid. Dropping this would let malformed
  sheets through. It must stay inside Generate — but scoped purely to the retry
  decision, not as the user-visible PostProcess.
- **The developer one-shot tools must not regress.** The CLI (`sprites:run`, with
  `--pick`, `selection.json`, the per-variant table) and the batch tooling are
  legitimately full-pipeline, one-shot tools. Gutting them to sheet-only would be
  an unjustified regression, and forking a second post-process path for them
  would reintroduce exactly the divergence ADR 0018 eliminated for slicing.

## Decision

**Split the old `generateOne` into a generate-only wrapper plus a shared
`generateSheetCore`, and add a `runFull` orchestrator for the one-shot tools that
reuses `generateSheetCore` + PR2a's `run-pipeline.ts` helpers — so there remains
exactly one post-process/judge code path.**

### 1. `generateSheetCore` — generate + store raw sheet + sliceability gate

A new internal, exported core in `scripts/sprites/generate-one.ts`: load + expand
the brief, build the prompt, call the provider (bounded retries), store
`sheet-NN.png`, and **slice the sheet purely as a quality gate**
(`cells.length === variantCount(brief)`, retry generation on a bad grid). It
deliberately writes **no `summary.json`** — the caller decides whether the run is
sheet-only or full. It returns the gate-validated `sliced` cells plus the
resolved inputs (`brief`, `palette`, `referencePngs`, `styleGuide`, `identity`)
the downstream stages need, so `runFull` never re-reads the sheet from the store.

### 2. `generateOne` — the GENERATE stage (sheet-only)

`generateOne` is now a thin wrapper: `generateSheetCore` + write a **minimal**
sheet-only `summary.json` (`candidates: []`, `diversity: null`, `chosen: null`,
`judgeBudget: null`, `judgeCache: null`, plus the run-identity fields incl. the
recomputed `variantCount`). It discards the gate's sliced cells — slicing here is
a quality check, not post-processing. `GenerateOneOptions` loses the judge-only
fields (`visionProvider`, `judgeBudget`, `judgeCache`, `env`); `textProvider`
stays because variation expansion is part of Generate (the prompt embeds the
final variations).

### 3. `runFull` — the one-shot full pipeline (`scripts/sprites/run-full.ts`)

A new orchestrator for the CLI + batch: `generateSheetCore` (reusing its sliced
cells) → `postprocessScoreAndStoreVariant` per variant → `runJudgePass({ judgeEnabled: brief.judge.enabled })`
→ `assembleSummaryEntries` → rank + diversity + chosen → write the **full**
`summary.json`. Every per-variant/judge step is a call into PR2a's
`run-pipeline.ts`, so a one-shot `runFull` and an explicit
generate → postprocess → judge sequence produce byte-identical artifacts — **one
post-process/judge path** (ADR 0018 discipline). `RunFullOptions extends
GenerateOneOptions` and re-adds the judge-only fields.

### 4. Consumer rewire

| Consumer                                   | Before               | After                 |
| ------------------------------------------ | -------------------- | --------------------- |
| sidecar `/api/workflow/generate` noop path | `generateOne` (full) | `generateOne` (sheet) |
| `worker.ts` (queue/devtools Generate)      | `generateOne` (full) | `generateOne` (sheet) |
| `cli.ts runOne` (`sprites:run`)            | `generateOne` (full) | `runFull`             |
| `batch.ts` (`generate` seam default)       | `generateOne` (full) | `runFull`             |

The worker is the real queue/devtools Generate path, so it goes sheet-only and
**drops the now-unused vision-provider plumbing** it used to pass into generate
(`worker.ts`, `worker-controller.ts`, `worker-cli.ts`). The worker no longer
judges; removing the plumbing is the honest change, not dead wiring left behind.

### 5. `rerun.ts` `variantCount` recompute guard (PR2a review carry-forward)

`repostprocessRun` rebuilds candidates from the re-sliced stored sheet but
previously carried `summary.variantCount` blindly via `...prior`. It now computes
`expected = variantCount(brief)`, throws a new
`RerunError('variant-count-mismatch')` (→ HTTP `422`) when `sliced.length !== expected`,
and writes the **recomputed** `variantCount: expected` into the rewritten
summary. This mirrors Generate's gate: a brief whose grid/variant config was
edited after generation no longer silently corrupts the summary.

## Consequences

### Positive

- The queue/devtools Generate stage now matches Option B: a Generate click yields
  a sheet-only run, and PostProcess/Judge are the explicit operator steps PR2a
  built. `POST /api/runs/:b/:r/postprocess` is unambiguously **the** first
  post-process, not a re-run of work Generate already did.
- One post-process/judge path is preserved. `runFull` consumes the same
  `run-pipeline.ts` helpers the re-run endpoints use, so the developer one-shot
  tools keep byte-identical behaviour without a forked pipeline.
- The bad-grid retry gate is retained (in `generateSheetCore`) while the heavy
  per-variant work moves out of Generate — malformed sheets are still rejected.
- The re-run guard makes a post-edited brief fail loudly (`422`) instead of
  writing a summary with a `variantCount` that disagrees with its candidates.

### Negative

- **Interim devtools degradation (expected, mid-stack).** Until PR2b-2 rewires
  the devtools UI, the Generate button produces a sheet-only run, so
  `applyGeneratedRunToQueue` shows 0 candidates. `verify.sh` runs
  unit/integration/headless (no Playwright E2E), so it stays green; PR2b-2
  restores the UX.
- The sheet-only `summary.json` written by `generateOne` reuses the
  `...identity` spread, so its JSON **key order** differs from the old coupled
  summary (`variations` now precedes `candidates`). All readers parse fields by
  name (`toEqual`/`JSON.parse`), so this is inert — but a raw-string snapshot of
  `summary.json` would notice.

### Risks

- A consumer that reads `summary.candidates` and assumes Generate populated them
  now sees `[]` for a sheet-only run. The known consumer (devtools
  `applyGeneratedRunToQueue`) is handled in PR2b-2; the sidecar GET, the
  re-run `...prior` merge, and devtools `sanitizeRunCandidate` all already
  tolerate empty candidates / null judge fields (PR2a posture), confirmed by the
  re-run + sidecar suites passing unchanged.
- `runFull` throws if a brief opts into judging (`judge.enabled: true`) but no
  vision provider is supplied — identical to the old `generateOne` guard, so no
  behaviour change for the CLI/batch.

## Alternatives Considered

- **Gut the CLI/batch to sheet-only too.** Rejected — they are legitimate
  one-shot full-pipeline tools; removing their post-process/judge tail is an
  unjustified regression with no product driver.
- **Fork a dedicated post-process path inside `runFull`.** Rejected — that
  reintroduces the divergence ADR 0018 eliminated for slicing. `runFull` calls
  the shared `run-pipeline.ts` helpers so parity is structural.
- **Keep `generateOne` coupled and add a `sheetOnly: boolean` flag.** Rejected —
  a boolean that silently changes which artifacts are written is exactly the kind
  of mode-coupling that makes the seam hard to reason about; two named entry
  points (`generateOne` sheet-only, `runFull` full) make the contract explicit at
  the call site.
- **Carry `summary.variantCount` through re-runs unchanged.** Rejected — PR2a's
  own review flagged that a post-edited brief would corrupt the summary; the
  recompute-or-reject guard is the safe mirror of Generate's gate.

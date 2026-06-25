# Handoff — 2026-06-26 rerunnable-postprocess-judge (PR2a)

## What Was Done

First PR of the **PR2 stack** that restructures the sprite-generation workflow
from 6 stages to 7 (`Synthesize → Choose → Generate → PostProcess → Judge →
Approve → Tag`). This PR is the **backend foundation only**: make PostProcess
and Judge **re-runnable over an already-generated run's stored sheet, WITHOUT
regenerating or discarding it**, sharing ONE code path with fresh generation so
a re-run reproduces generation-time artifacts byte-for-byte.

No UI / state-machine changes here — those are PR2b (7-stage machine + drop
Promote) and PR2c (sensor-failure visibility + force-judge UI + Playwright
E2E), already scoped in the session todo DB.

### Design validation (vs. the original brief)

Two brief assumptions were checked against the code and adjusted:

- **Raw sheets are ALREADY durable.** `generateOne` already persists every
  attempt's sheet via the injected `RunStore` (`<briefId>/<runId>/sheet-NN.png`,
  local or Azure — ADR 0017). No new persistence was needed; the re-run reads
  the existing sheet as its source artifact.
- **Per-sensor failure detail ALREADY exists** in `summary.json`
  (`RunSummaryEntry.breakdown`). PR2c only needs to surface it in the UI.
- **Next free ADR number is 0023** (0019–0022 already taken; the brief said
  0019).

### Implementation

**1. Shared per-variant pipeline — `scripts/sprites/run-pipeline.ts` (NEW)**

Lifted the per-variant work out of `generateOne` verbatim so generation and
re-run can't diverge:

- `postprocessScoreAndStoreVariant` — post-process one raw cell, score it, write
  every artifact (raw/processed PNG, scorecard, pipeline-step PNGs + index,
  anchor sidecars, anchor-overlay) through the store.
- `runJudgePass` — the gated VLM judge. Same eligibility as generation
  (sensor-passing, ranked by score, capped at `judge.maxVariants`) plus two NEW
  params: `force` (judge sensor-FAILED variants) and `variantIndexes` (judge a
  subset). Returns plan/skip maps covering only the considered variants.
- `assembleSummaryEntries` — fold sensors + judge into `RunSummaryEntry[]`,
  computing `combinedPassed = passed && (!judgeEnabled || judge.passed)` in one
  place.

`generateOne` now CONSUMES these (542 → 332 lines). Behaviour equivalence is
pinned by the pre-existing integration suites (`generate-one.test.ts`,
`judge-pipeline.test.ts`), which pass unchanged.

**2. Re-run orchestrator — `scripts/sprites/rerun.ts` (NEW)**

- `repostprocessRun` — re-slice the stored sheet (content-aware, ADR 0018) and
  re-post-process + re-score all variants with tweakable `PostprocessOptions`,
  overwriting `processed/**` + `summary.json` in place. **Resets judge verdicts**
  (prior verdicts judged different pixels) → `judgeScorecard: null`,
  `judgeSkipReason: null`, `combinedPassed` on sensors alone.
- `rejudgeRun` — re-judge the stored `processed/NN.png` without touching pixels.
  Supports `force` / `variantIndexes`, and **merges** new verdicts over the prior
  summary so an untouched variant keeps its verdict.
- Decoupled from the sidecar: takes pre-loaded `brief`/`palette` (+
  references/style guide) and the loaded `RunSummary`, so it's unit-testable
  against a `LocalRunStore` tmp dir with no HTTP. Typed `RerunError` carries a
  `kind` the sidecar maps to an HTTP status.

**3. Sidecar endpoints — `scripts/sprites/sidecar/server.ts`**

- `POST /api/runs/:briefId/:runId/postprocess` `{ options?, sheet? }` —
  deterministic, **CI-safe**.
- `POST /api/runs/:briefId/:runId/judge` `{ variantIndexes?, force? }` —
  LLM-as-judge, **refused in CI** (Constitutional §3, 403); 400 when no vision
  provider is configured.
- Shared `resolveRunForRerun` helper mirrors the slice-map handler (load summary
  → resolve brief) + the generate handler's re-materialisation of a
  checkpoint-wiped draft brief. `rerunErrorStatus` maps `RerunErrorKind` →
  status (404 / 415 / 500).

## Files Changed

- `scripts/sprites/run-pipeline.ts` (NEW — shared per-variant pipeline)
- `scripts/sprites/rerun.ts` (NEW — re-run orchestrator)
- `scripts/sprites/generate-one.ts` (refactored to consume run-pipeline; 542→332)
- `scripts/sprites/sidecar/server.ts` (2 endpoints + `resolveRunForRerun` +
  `rerunErrorStatus` + imports/body interfaces + header doc)
- `tests/fixtures/sprites/seed-run.ts` (NEW — seeds a real run via `generateOne`)
- `tests/unit/sprites/run-pipeline.test.ts` (NEW — pure gating + combinedPassed, 8 tests)
- `tests/integration/sprites/rerun.test.ts` (NEW — re-run over seeded runs, 14 tests)
- `tests/integration/sprites/sidecar-rerun.test.ts` (NEW — endpoint gates, 8 tests)
- `docs/knowledge/adr/0023-rerunnable-postprocess-judge.md` (NEW)

## Test Strategy / Placement

- **`run-pipeline.test.ts` is a UNIT test** (`tests/unit/`): pure gating logic
  (`runJudgePass` force / variantIndexes / over-cap / sensor-failed /
  judge-disabled) + `assembleSummaryEntries` combinedPassed. Uses a tiny 16×16
  PNG + mock vision provider so it runs in ~50 ms.
- **`rerun.test.ts` + `sidecar-rerun.test.ts` are INTEGRATION tests**
  (`tests/integration/sprites/`) because each seeds a real `generateOne` run
  (slice + postprocess a 2048×2048 sheet), which is too slow for the unit
  project (`verify:fast` runs `--project unit` only). This mirrors the existing
  `tests/integration/judge-pipeline.test.ts`.
- A **byte-for-byte parity** assertion in `rerun.test.ts` confirms re-post-
  processing the stored sheet reproduces the generation-time `processed/NN.png`.

## Verification

- `npm run typecheck` ✅
- `npm run lint` ✅
- `npm run verify` ✅ — typecheck, lint, prettier, knip, unit+coverage,
  integration (47 pass / 1 skip across 10 files, incl. the 2 new suites),
  headless Floor 1 (44 pass), `vite build`.
- `bash scripts/agent/lab-gate-check.sh` — **N/A / passes by inspection**: this
  PR touches only `scripts/`, `tests/`, `docs/` — **zero** changes under
  `src/core/systems/` or `src/labs/`, so the gate's inputs are identical to
  main. (The script itself is pathologically slow under Windows Git Bash —
  ~50 s/system from subprocess forking — so it was not run to completion here;
  it is green in CI.)

## Apples

- Estimated: 🍎🍎🍎🍎 (Large)
- Actual: 🍎🍎🍎🍎 (Large)
- Verdict: 🎯 exact (delta 0)
- Reason: scope landed where expected — one shared module, one orchestrator, two
  endpoints, three test files + a seed helper, one ADR. Two small wiring bugs
  (endpoint `old_str` ate the approve route header; vision-provider null
  narrowing) and a test-placement adjustment (moved generation-heavy tests to
  integration), but no scope creep.
- Hello kitties: 0.8

## Follow-ups (rest of the PR2 stack)

Tracked in the session todo DB:

- **PR2b** (`pr2b-state-machine`, `pr2b-ui-drop-promote`): rewrite the pure
  state machine `src/devtools/sprite-workflow-queue.ts` to the 7 stages and the
  devtools UI in `src/devtools-main.ts`; **drop the standalone Promote stage**
  (fold brief promotion into Choose→Generate).
- **PR2c** (`pr2c-sensor-visibility`, `pr2c-force-judge-ui`, `pr2c-e2e`):
  surface per-sensor failure detail (already in `summary.breakdown`) per variant;
  add a force-judge UI control wired to the judge endpoint's `force` flag;
  Playwright E2E against a live Azure sidecar (`npm install` +
  `npm run setup:azure`) — generate a sheet, re-run PostProcess + Judge on the
  STORED sheet without regenerating, verify sensor-failure detail, force-judge
  past a failing sensor, confirm resume-after-refresh.

## Notes / Gotchas for the next agent

- **Sheet selection**: re-run defaults to the newest `sheet-NN.png` (matches
  `/api/slice-map`); override via `body.sheet` (`sheet-NN.png`). Bad filename →
  415 `unsupported-sheet-filename`.
- **`rejudgeRun` needs `processed/NN.png`** — if PostProcess wasn't run (or
  artifacts pruned) it throws `processed-missing`. PR2c UI should run PostProcess
  before offering Judge, or surface this error.
- **`repostprocessRun` resets `judgeSkipReason` to `null`** ("post-processed,
  not yet judged") — a new state distinct from `judge-disabled`. No new
  `RunSummary` fields were added (avoids breaking serialization guards).
- **Azure-blob judge quirk** (preserved from generation): `judgeVariant`'s
  `processedDir` is only passed when `store.backend === 'local'` — for azure the
  resolved blob URL would make `path.join` produce an ENOENT path. The judge
  scorecard still embeds in the summary, so no data is lost.
- **Judge happy-path** is tested at the `rerun.ts` layer with a mock vision
  provider (the sidecar builds its provider from env via `createVisionProvider`,
  with no injection seam). The endpoint tests pin the gates the sidecar owns
  (CI refusal, vision-not-configured, validation, run resolution).

# Handoff — 2026-06-26 pr2b-2-7-stage-workflow (PR2b-2)

## What Was Done

Third PR of the **PR2 stack** (after PR2a #323, PR2b-1 #337). Restructures the
devtools sprite-generation workflow from the OLD 6-step model to the 7-step
**Option B** model and drops the standalone Promote step. Formalised in
**ADR 0025** (`workflow-7-stage-restructure`).

```
OLD: Synthesize → Choose → Promote → Generate → Approve → Tag
NEW: Synthesize → Choose → Generate → PostProcess → Judge → Approve → Tag
```

Apple estimate: **🍎🍎🍎🍎 (Large)**; scored **4** at handoff (delta 0, exact —
see `docs/knowledge/metrics/apples/2026-06-26-pr2b-2-7-stage-workflow.json`).

**NOT in this PR** (→ PR2c): per-sensor failure _rendering_, the force-judge
_button_, Playwright E2E. The data (`breakdown`/`sensors`) and the `force` backend
already exist from PR2a and keep flowing through queue state untouched.

## Changes

### State machine — `src/devtools/sprite-workflow-queue.ts`

- `WORKFLOW_STAGES`: dropped `promoting`/`promoted`; added `sheet`,
  `postprocessing`, `postprocessed`, `judging`. New order: `draft, synthesizing,
candidates, generating, sheet, postprocessing, postprocessed, judging, variants,
approved, tagging, done`.
- `STEP_LABELS` (7): `Synthesize, Choose, Generate, PostProcess, Judge, Approve,
Tag`.
- `STAGE_ACTIVE_STEP`: `sheet`/`postprocessing` → 3, `postprocessed`/`judging` →
  4, `variants` → 5, `approved`/`tagging` → 6, `done` → 7 (was 6).
- `BUSY_STAGES`: `synthesizing, generating, postprocessing, judging, tagging`
  (dropped `promoting`).
- `primaryActionLabel`: `candidates` → "Generate run", `sheet` → "PostProcess",
  `postprocessed` → "Judge".

### Devtools UI — `src/devtools-main.ts`

- **Dropped Promote**: removed the Promote button, its click handler, and the
  `promoting`/`promoted` badges. The `POST /api/workflow/promote-brief` call now
  runs **inside the Generate handler**: when `item.briefPath === null`, Generate
  promotes the chosen candidate first (sets `briefPath`, adds the draft-brief key,
  `void recompute()`), then generates. Choose→Generate replaces
  Choose→Promote→Generate with no behaviour loss.
- **Generate lands a sheet-only run**: `applyGeneratedRunToQueue` →
  `applyRunToQueue(itemId, briefId, runId, candidates, opts)` (stage + status +
  optional `resetApproval`). Generate targets stage `sheet`, stores the `run` even
  with `candidates: []`. Both sync + queued/worker poll paths reset to `candidates`
  (was `promoted`) on cancel/error. Generate is reachable **only from
  `candidates`**; re-rolling a fresh sheet is via re-Choosing (which resets
  `briefPath`/`run`), so the cancel/error reset collapses to a single `candidates`
  target.
- **PostProcess + Judge buttons** wired to the PR2a endpoints
  (`POST /api/runs/:b/:r/postprocess`, `/judge`), bodies `JSON.stringify({})`.
  Both merge `result.summary?.candidates ?? []` back via the **unchanged**
  `toWorkflowRunState` mapper (preserves `judge` + `sensors`/`breakdown`).
  PostProcess: `sheet` → `postprocessed`, re-runnable from `postprocessed`/
  `variants`. Judge: `postprocessed`/`variants` → `variants`, gated behind
  PostProcess (only enabled once `run.candidates.length > 0`). On error, both
  restore the prior stage.
- **Stage-aware `renderRunCandidates`**: 0 candidates → "raw sheet stored, no
  variants yet" + PostProcess hint (early return); post-processed-but-not-judged
  (`!ranked.some(c => c.judge !== null)`) → "N variant(s) post-processed, not yet
  judged" + Judge/Approve hint; judged → existing "N/M pass the judge" title.
  Per-card status label distinguishes `sensor fail` from `judge fail`.
- Updated button enablement in both branches of `renderWorkflowSelection`, the
  `STAGE_BADGES` record, and the synth-complete status text ("then Generate").
- Kept the persisted `promotedBriefPath` field name in
  `PersistedFloorArtWorkflowState` for back-compat (it mirrors `item.briefPath`).

### Tests — `tests/unit/devtools-sprite-workflow-queue.test.ts`

38 → 41 tests. New coverage for the `sheet`/`postprocessing`/`postprocessed`/
`judging` stage steps, `stepperFor` busy stages, `primaryActionLabel` for the new
stages, serialize/deserialize round-trips, and sensor preservation through
deserialize.

## Verification

- `npm run verify:fast` — **green** (full-src typecheck + lint + changed unit
  tests).
- `npm run verify` — typecheck, lint, format, dead-code, **unit (41)**,
  **integration (50, 1 skip)** all green. The only failures were 2 **wall-clock
  perf-regression flakes** in the unrelated Floor 1 headless gate (Step 7/8) —
  see below.
- `bash scripts/agent/lab-gate-check.sh` — **green** (no new ECS system; all
  existing systems still lab-covered).

### Floor 1 headless wall-clock flake (NOT a regression)

The headless gate (`tests/headless/floor1-completion.test.ts`) failed its
`HEADLESS_WALL_TIME_BUDGET_MS` (30s) guard on 2 seeds per run. **Confirmed
environmental, not caused by this PR:**

- The headless test imports **only** `src/game/ai/*` + `src/shared/*` — **zero
  dependency** on `src/devtools/*` (this PR's only code changes).
- The simulation is deterministic: **frame counts are identical** run-to-run
  (seed 3 · bow = 15804 frames both runs). Only the wall-clock _wrapper_ time
  varies.
- The failing seeds + timings are **non-deterministic** across runs (run 1: seed 3
  @ 30.4s + seed 5 @ 33.0s; run 2: seed 3 @ **41.8s** + seed 7 @ 32.8s) — the
  signature of CPU contention on a shared/slow box, not a stable perf regression.
- The test's own message: _"a coarse blowup guard, not a precise SLA … profile the
  AI before raising the budget."_

The budget is calibrated for CI runners (the reference env), where `main` is green.
**Did NOT touch the Floor 1 AI perf budget** — that would be out-of-scope churn for
a devtools PR and is explicitly cautioned against by the test. CI is the gate for
this perf guard.

## Carry-forward → PR2c

- **Per-sensor failure rendering + force-judge button**: the `breakdown`/`sensors`
  data and the `force` backend already exist (PR2a); they flow through queue state
  untouched here. PR2c renders/wires the UI on top of this restructure.
- **Atomic `LocalRunStore.put` / tolerant `loadRunSummary`** (PR2a carry-forward):
  stays **deferred**. PostProcess/Judge are triggered one-at-a-time per item via
  busy-stage gating (`postprocessing`/`judging`) — no concurrent re-run UI — so the
  atomic-write race does not become live here.
- **Stale `processed/NN.judge.json` sidecar cleanup on judge reset** (PR2a cosmetic
  carry-forward): untouched — this PR adds no operator-side variant/emptyCells
  editing, so the re-postprocess `variant-count-mismatch` guard (PR2b-1) stays
  honest.
- Behaviour change to flag in PR2c E2E: re-rolling a fresh sheet now requires
  re-Choosing (not regenerate-from-`variants`).

## Key files

- `src/devtools/sprite-workflow-queue.ts` — pure state machine (the foundation).
- `src/devtools-main.ts` — workflow UI (`applyRunToQueue`, the PostProcess/Judge
  handlers, the folded-promote Generate handler, stage-aware `renderRunCandidates`).
- `scripts/sprites/sidecar/server.ts` — PR2a PostProcess/Judge endpoints (READ
  ONLY; unchanged).
- `docs/knowledge/adr/0025-workflow-7-stage-restructure.md` — the ADR.

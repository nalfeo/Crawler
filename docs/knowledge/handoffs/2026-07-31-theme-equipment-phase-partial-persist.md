# Handoff: Graceful per-item degradation in theme-equipment run-phase

**Date:** 2026-07-31
**Branch:** `theme-set-classic-fantasy-basic-cloth`
**Apple estimate:** 3🍎 (asset-pipeline tooling cap per AGENTS.md)
**Apple actual:** 3🍎 — exact (calibration: `docs/knowledge/metrics/apples/2026-07-31-theme-equipment-phase-partial-persist.json`)

## Systems touched

sprite-pipeline, sprite-workflow

## Problem

`runThemeEquipmentSetPhase` looped items with no per-item guard, so any single
item throw aborted the whole phase and the runner never reached
`saveThemeEquipmentSetState`. Every accepted item from the same pass was
discarded in-memory. Live symptom: generating **Classic Fantasy [Basic Cloth]**
stalled when the variant-approval item `simple-cloth-sandals` failed with
"0 acceptable variants" and wiped ~18 items of paid generation.

Maintainer's guiding directive: _"we shouldn't throw away accepted work! It
should be saved and checkpointed and retries are up to the driver for whether to
start from scratch or retry/retune just the failures."_

## What changed (end-of-pass partial-state recovery / graceful per-item degradation)

- **`theme-equipment-pipeline.ts`** — `runThemeEquipmentSetPhase` now wraps each
  item and returns a `ThemeEquipmentSetPhaseRunResult`
  `{ state, succeededItemIds, itemFailures[], collectionJudgeError, fatalError }`
  and never throws (except the not-a-review-phase guard). On a caught throw,
  `applyFailureMarker` marks the item first (durable `generationError` marker via
  `recordThemeSetItemPhaseFailure`, bumps `stateRevision`), then splits:
  marker-mutation rejected → fatal `ThemeEquipmentPipelineError`; else
  `RecoverableThemeSetItemError` → continue; else `fatalError` (original error) +
  break. The collection judge runs **only** when
  `!fatalError && itemFailures.length === 0`.
- **`theme-equipment-runner.ts`** — `finishPhaseRun` persists the partial state
  before surfacing failures: `fatalError` → save + rethrow verbatim; recoverable
  `itemFailures`/judge error → persist then throw
  `ThemeEquipmentSetPhasePartialError(message, persistedState, succeededItemIds,
itemFailures, collectionJudgeError)`; clean → return persisted. `init` always
  saves (`expectedRevision: null`); `runPhase` saves only when the run mutated
  state.
- **`theme-equipment-cli.ts`** — `main()` catches `ThemeEquipmentSetPhasePartialError`,
  writes `sanitizeStatus(error.state)` to **stdout** (so the canvas still gets the
  checkpointed state), the partial message to **stderr**, and exits 1. Other
  errors → `failed: <msg>` on stderr, exit 1.
- **`theme-equipment-set.ts`** — `recordThemeSetItemPhaseFailure` +
  `generationError` marker; the durable marker is excluded from
  `computeBulkApprovePlan`.

The design is **end-of-pass** partial-state recovery — accepted items in a pass
are checkpointed when the pass ends. Per-item real-time checkpointing (surviving
a hard crash/OOM/timeout mid-item) is a documented follow-up, not this PR.

## Verification (observe before done)

- Full theme-equipment sprites suite: **182 passing** (`npx vitest run --project
sprites theme-equipment`). Note: `tests/unit/sprites/**` is excluded from the
  `unit` vitest project — use `--project sprites`.
- `npm run verify:fast` — passed (typecheck + lint + changed unit tests + size/
  weight coverage).
- Runtime behavior is exercised by the runner/pipeline unit tests against an
  in-memory store: a recoverable item failure persists `succeededItemIds` and
  surfaces `ThemeEquipmentSetPhasePartialError` with the checkpointed state; a
  fatal item error checkpoints the marked item exactly once (`store.puts === 1`)
  and rethrows the original error verbatim (`expect(error).toBe(sentinel)`).

## Review harness (3🍎)

Ledger: `docs/knowledge/review-ledgers/2026-07-31-theme-equipment-phase-partial-persist.review-ledger.json` (validates, exit 0).

- **plan_review** — gpt-5.6-sol, 2 rounds, 8/8 concerns resolved, `plan_divergence: minor`.
- **code_review** — gpt-5.3-codex (distinct from plan reviewer), 3 rounds:
  R1 found 2 Medium coverage gaps (CLI partial-checkpoint contract; runner fatal
  save-then-rethrow) → both fixed with tests; R2 raised 1 refinement (assert
  object identity, not just instanceof+message) → fixed with a sentinel prototype
  spy + `toBe(sentinel)`; R3 clean confirmation.

## Watchouts for the next session

- **Do NOT dispatch `run-phase` on `classic-fantasy-basic-leather`** — it has an
  in-flight human review that a fresh run would destroy.
- After this merges to main: re-dispatch
  `gh workflow run theme-equipment.yml --ref main -f action=run-phase -f
set_id=classic-fantasy-basic-cloth`; regen/retune only the failed item
  (`simple-cloth-sandals`); drive final review through the canvas; then dispatch
  `publish`. Paid runs take ~30+ min.
- `.env.local` is NOT auto-loaded by a bare `npx tsx scripts/sprites/*-cli.ts`
  (`SPRITES_RUN_STORE` defaults to `local`); parse it into `process.env` for any
  ad-hoc inspection script.

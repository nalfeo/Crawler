# Handoff — 2026-06-25 sprite-slice-unification

## What Was Done

Fixed a user-reported divergence where the sprite-generation **workflow grid**
showed garbage/mis-sliced variant thumbnails while the **post-process debugger**
and the **final committed sprite** looked clean. Root cause: two slicing
algorithms in one function, used by different callers. Unified everything onto
the content-aware path and deleted the old equal-division slicer.

### Root Cause

`scripts/sprites/slice-sheet.ts` shipped two algorithms inside
`computeSliceMapV2`, branched on whether `rows`/`cols` were passed:

- **Equal-division** (generation, via `sliceSheetFromBrief` passing brief
  `rows`/`cols`) → uniform grid cuts → mis-sliced uneven/off-grid sheets →
  garbage thumbnails in the workflow grid.
- **Content-aware band detection** (debugger `/api/slice-map`, passing only
  `emptyCells`) → cuts at background gutters → clean.

Same sheet, two outputs. The final catalog sprite looked fine because `approve`
re-runs a clean path; only the **review preview** diverged.

### Fix

In `scripts/sprites/slice-sheet.ts`:

- Deleted all equal-division / v1 code (`computeSliceMap` v1, `sliceSheet` v1,
  `inferRowOffsets`/`inferColOffsets`, foreground-count helpers, the
  `rows`/`cols` branch, and the `rows`/`cols` fields on options).
- Renamed the surviving V2 symbols to canonical names: `computeSliceMapV2 →
computeSliceMap`, `sliceSheetV2 → sliceSheet`, `SliceOptionsV2 → SliceOptions`.
- `sliceSheetFromBrief` now calls `sliceSheet(sheetPng, { emptyCells })` — brief
  `rows`/`cols` are no longer used for slicing (they stay a prompt layout hint).

In `scripts/sprites/sidecar/server.ts`:

- `/api/slice-map` imports and calls `computeSliceMap`; reports
  `algorithm: 'content-aware'` (was `'v2'`).

Background-option drift guard:

- `tests/unit/bg-remove.test.ts` — added a `describe` asserting
  `BACKGROUND_B_COLOR_TOLERANCE_SQ === 4000` and
  `BACKGROUND_B_FRINGE_TOLERANCE_SQ === 12000` (must equal devtools
  `DEFAULT_BACKGROUND_TWEAKS`).
- `src/devtools-main.ts` — cross-reference comment on `DEFAULT_BACKGROUND_TWEAKS`
  pointing at the generation-side constants.

Tests:

- `tests/unit/sprites/slice-sheet.test.ts` — rewritten content-aware only
  (margin trim, grid detection from gutters, reading-order extraction, a
  fast-check property over arbitrary gridded sheets, empty-cell skipping, and
  "ignores brief rows/cols and slices by content").
- `tests/unit/sprites/sidecar-server.test.ts` — two `algorithm` assertions
  updated `'v2' → 'content-aware'`.

## Files Changed

- `scripts/sprites/slice-sheet.ts` (rewritten — single content-aware slicer)
- `scripts/sprites/sidecar/server.ts` (import/call/algorithm label)
- `src/devtools-main.ts` (cross-reference comment on `DEFAULT_BACKGROUND_TWEAKS`)
- `tests/unit/bg-remove.test.ts` (background-tweaks lock guard)
- `tests/unit/sprites/slice-sheet.test.ts` (rewritten)
- `tests/unit/sprites/sidecar-server.test.ts` (2 assertions)
- `docs/knowledge/adr/0018-unify-sheet-slicing-content-aware.md` (new)

## Apples

- Estimated: 🍎🍎🍎🍎 (Large)
- Actual: 🍎🍎🍎 (Medium)
- Verdict: over (−1)
- Reason: the feared PR #164 edge-touch regression and integration-fixture
  rework never materialised — all 25 integration tests passed with zero fixture
  changes, so the bulk of the anticipated complexity evaporated. Net work was a
  contained delete-one-algorithm refactor plus tests + ADR.
- Hello kitties: 0.60

## Verification

- `npx vitest run tests/unit/bg-remove.test.ts tests/unit/sprites/slice-sheet.test.ts` ✅ (31 tests)
- `npm run verify:fast` ✅
- `npm run verify` ✅ (typecheck, lint, format, dead-code, unit+coverage,
  integration 25 pass/1 skip, headless Floor 1 gate, build)
- `bash scripts/agent/lab-gate-check.sh` ✅ (no new ECS system — infra change)

## Follow-ups (PR2 — separate, after this merges)

Tracked in the session todo DB; the user explicitly scoped these as a second PR:

- `wf-stages-redesign`: restructure workflow 6→7 stages (Synthesize / Choose /
  Generate / **PostProcess** / **Judge** / Approve / Tag).
- `wf-rerun-postprocess-judge`: re-run PostProcess + Judge on durable stored
  sheets **without discarding** the generated sprite sheets.
- `wf-drop-promote`: remove the standalone Promote stage.
- `wf-sensor-failure-visibility`: surface **which** sensors failed.
- `wf-force-judge`: allow forcing the LLM judge to run even when not all sensors
  passed.

## Blockers

- Branch rename was blocked ("a pull request is associated with this session" —
  the merged PR #296). This PR is therefore opened from the existing branch
  `nalfeo-azure-workflow-state-persistence` even though its name reflects the
  prior (merged) Azure work. Functionally fine; cosmetic only.

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

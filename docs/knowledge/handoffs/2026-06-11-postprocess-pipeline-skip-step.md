# Handoff: Postprocess pipeline skip step + slicing as first pipeline step

**Date:** 2026-06-11  
**Branch:** `nalfeo/sprite-generation-workshop`  
**Commit:** 50e6e28

## What was done

Redesigned the DevTools postprocess debugger in `src/devtools-main.ts`:

1. **Slicing is now the first pipeline step** — removed the standalone "Slicing" section; the slicing canvas, v1/v2 A/B buttons, and variant selector are now rendered inside a step card at position 0 of the pipeline.

2. **Skip/disable per step** — every pipeline step card (including slicing) has a Skip button. Skipping a step displays an amber "⏭ SKIPPED — passing through" badge and treats the step's input as its output for cascade to the next step.

3. **Removed `syncPipelineBranchFromSlice`** — slicing algorithm choice (v1/v2) and pipeline step branch selection (A/B) are now fully independent.

4. **Resolved 4 merge conflict markers** that had accumulated from stash/upstream divergence.

## Key file

- `src/devtools-main.ts`
  - `makeSlicingStepCard` (~line 1790): renders slicing as step 0 card
  - `makeComparisonStepCard` (~line 1673): now takes `skipped` + `onSkipToggle`
  - `renderPipelineSteps` (~line 2048): `collapsedSteps` Set; cascade logic; `lastActiveBranch`

## Open issues

- **V2 outer margin trimming** — user noted it looked unchanged. The trim logic in `computeSliceMapV2` (`scripts/sprites/slice-sheet.ts`) may need visual debugging against a real sprite sheet.

## Verification

`npm run verify:fast` → 1156 tests pass ✓

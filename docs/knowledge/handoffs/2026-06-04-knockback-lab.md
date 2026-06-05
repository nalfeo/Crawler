# Handoff: Knockback Lab

**Date:** 2026-06-04
**Branch:** `nalfeo-microsoft-ubiquitous-adventure`
**Status:** Complete

## What changed

- Replaced the placeholder `src/labs/knockback-lab/index.ts` with a canvas-based knockback visualization.
- Added click-to-spawn entities, drag-to-apply knockback, and a `Knock All` action with seeded random directions.
- Added lil-gui controls for `speed`, `distance`, `entityCount`, and `Reset`.
- Rendered active knockback arrows and color changes to show motion state.
- Implemented a requestAnimationFrame loop that mirrors the knockback system math (`step = min(speed, remaining)`).

## Validation

- `npm run typecheck` ✅
- `npm test` ✅
- `npm run lint` ⚠️ fails due to pre-existing errors in `src/labs/health-lab/index.ts` (`@typescript-eslint/no-explicit-any`)
- `npx eslint src\labs\knockback-lab\index.ts` ✅

## Notes

- I did not modify unrelated pre-existing changes already present in the worktree (`health-lab`, `lifetime-lab`, `damage-lab/SPEC.md`).

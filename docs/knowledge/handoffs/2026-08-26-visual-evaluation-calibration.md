# Visual evaluation calibration

**Date:** 2026-08-26  
**Author:** Copilot CLI (DevOps Engineer)  
**Session Branch:** nalfeo-equipment-ux-redesign

## Summary

- Declared focus clips now identify a detailed hover frame while measured regions retain
  full-panel placement context.
- Deterministic scenario contracts own geometry/spacing status; unsupported model geometry
  claims and generic cramped/padding/theme opinions are retained as advisory notes.
- Focused hover scores heavily weight task readiness, target identity/visibility,
  non-occlusion, and readable text. A clean scoped deterministic contract receives an
  80-point floor unless an evidence-backed model blocker remains.
- Reports now separate deterministic status, evidence-backed blockers, advisory taste notes,
  confidence, and focus/full capture scope.
- Calibration tests lock the clean tooltip scenario at `>=80` and preserve target-tooltip
  occlusion as a deterministic failure.

## Coupled runtime repair

The required deterministic visual suite exposed two stable tooltip defects already present
on the branch: compact title bounds landed on a half-pixel, and candidate comparison flavor
text collided with `No stat change`. Compact titles now use an integer top-left raster
position, comparison cards omit secondary flavor copy, and the pure tooltip layout reserves
measured description/difference regions.

Before: `fractionalTextBounds=1`, then a 962px² description/delta collision.  
After: the real Phaser equipment decision gate passes at both supported viewports.

## Validation

- `node --test scripts/agent/review/visual-review-lib.test.mjs` — 58 passed.
- `npx vitest run tests/unit/visual-review-agent-cli.test.ts` — 20 passed.
- `npx vitest run tests/unit/item-tooltip.test.ts` — 4 passed.
- `npm run review:visual:deterministic` — 31 passed.
- `npm run typecheck` — passed.
- `npm run verify:fast` — passed.

## Systems touched

hud-ux, inventory, devtools

## Apples

**Estimated:** 3🍎  
**Actual:** 3🍎  
**Verdict:** 🎯 Exact — the tooling calibration plus coupled deterministic tooltip repair
matched the medium estimate.

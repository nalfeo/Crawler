# Equipment hover judge

**Date:** 2026-08-24  
**Author:** Copilot App (UX Designer)  
**Session Branch:** nalfeo-equipment-ux-redesign

## Summary

Made the equipped-item hover scenario truthful and reviewable:

- it equips and previews the real Iron Helm rather than forcing an empty-slot tooltip;
- Head remains visibly selected as the hover target while the tooltip appears;
- the tooltip is placed beside, never over, the target and is promoted above panel content;
- the reviewer prompt now treats an empty/unemphasized hover target, a covering tooltip,
  or a tooltip behind panel content as blocking findings.

Tooltip probe bounds now report the actual clipped card instead of Phaser's unconstrained
child-text bounds. The real-game test asserts target selection, target/card non-overlap,
and topmost tooltip rendering. The ten-slot contract is unchanged.

## Visual evidence

`files/visual-review/after/v0.1.18/equipment-hover-equipped.{png,review.json}` is the
real Phaser/Azure capture. It reports 25 declared regions and zero deterministic blockers.
The screenshot visibly shows the occupied Head slot, gold target emphasis, and adjacent
non-occluding tooltip. Azure's only advisory blocker is an unsupported subjective
"cramped tooltip" claim; deterministic geometry and text containment pass.

## Validation

- `npm run verify:fast` — passed.
- `npx vitest run --project e2e tests/e2e/inventory-flow.test.ts -t "captures equipped"` — passed.
- `node --test scripts/agent/review/visual-review-lib.test.mjs` — 53 passed.
- `node --test scripts/agent/review/text-raster-lib.test.mjs` — 6 passed.
- `npm run typecheck` — passed.

## Systems touched

inventory, hud-ux, devtools

## Apple estimate

**Estimated:** 3🍎  
**Actual:** 3🍎

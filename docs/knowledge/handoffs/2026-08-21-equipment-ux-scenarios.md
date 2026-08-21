# Equipment UX scenarios

**Date:** 2026-08-21  
**Author:** Copilot App (UX Designer)  
**Session Branch:** nalfeo-equipment-ux-redesign

## Summary

Completed the explicit, manifest-driven Equipment A|B scenario contract. The UI-probe setup now captures the five requested interaction states without inventing scenarios from screenshot folders:

- Equipment: opened panel with no forced hover, preview, filter, or tooltip.
- Equipment Hover (Equiped): equipped Head tooltip.
- Equipment Hover (Duplicate): equipped and bag Iron Helm comparison with no delta.
- Equipment Hover (Empty Slot): Leather Boots comparison with an empty Feet slot.
- Equipment Hover (Stats delta): generated Runed Chain Hauberk replacing Iron Breastplate with a non-zero delta.

Generated equipment previews now calculate the same read-only swap delta as catalog equipment. The scenario fixture uses a valid common generated item with an immutable probe run key.

The neutral Equipment layout was subsequently polished without changing the ten-slot contract:

- square 64px paper-doll controls with compact 12px column gaps;
- the overlapping 8px `— empty —` cue removed while retaining all slot labels;
- a full-width, padded Equipment header aligned with Stats and Bag;
- the idle inspector hidden so the doll is vertically centered when no item is hovered;
- `Current totals` and section underlines removed; stat rows are vertically centered and `Cooldown Reduction` is not truncated.

## Visual evidence

Current captures and Azure LLM reviews are stored session-locally at:

`files/visual-review/after/v0.1.0/{equipment,equipment-hover-equipped,equipment-hover-duplicate,equipment-hover-empty-slot,equipment-hover-mixed-delta}.{png,review.json}`

All five capture contracts report ten declared slot regions and zero deterministic geometry blockers. The Azure reviews remain `needs-work`; their subjective tooltip/stat-panel critiques require the maintainer's requested finding-by-finding disposition before further design changes.

The polished neutral capture and Azure review are stored at
`files/visual-review/after/v0.1.1/equipment.{png,review.json}`. It is a changed
real-Phaser capture with ten declared slots and zero deterministic blockers. Its 65/100
derived advisory score exceeds the prior 53.1/100 deterministic-equivalent baseline
(67.1 axis mean minus 14 blocker penalty).

Follow-up user feedback was addressed in
`files/visual-review/after/v0.1.3/equipment.{png,review.json}`:

- the responsive layout path now preserves the contained Equipment-header frame;
- occupied slots use a brighter inset/overlay while empty slots are recessed;
- stat rows have one consistent neutral treatment instead of arbitrary striping;
- `green = gear bonus` explicitly explains green stat values.

The v0.1.3 Azure pass has zero deterministic blockers and zero LLM blockers. The
header frame is now asserted contained in the real-Phaser e2e probe at both supported
viewports.

No `before/live-dev` evidence was created: this workspace has no checked-in release baseline or detached baseline worktree. Capturing current-branch pixels as live evidence would fabricate provenance. Populate that side from the release capture workflow or an explicitly provisioned immutable release checkout.

### v0.1.5 calibration and UX refinement

`files/visual-review/after/v0.1.5/{equipment,equipment-hover-equipped,equipment-hover-duplicate,equipment-hover-empty-slot,equipment-hover-mixed-delta}.{png,review.json}`
contains the regenerated Azure review set. Every scenario declares the three header
regions plus panel/slot geometry and reports zero deterministic blockers.

- Empty placeholder silhouettes are lighter, while occupied slots remain visibly
  distinct.
- The `green = gear bonus` legend is removed. A stat is green only when its
  formatted effective value visibly differs from its formatted base value.
- Stats header text now uses the same pixel-centering helper as Equipment and Bag.
- The review prompt and deterministic post-review filter reject claims about
  Ring 1/Ring 2 sharing a row, optical centering without measured container
  evidence, header alignment when declared header centers share a baseline, and
  bag-icon centering without declared icon geometry.

The Azure judge remains advisory: it continues to offer subjective tooltip-density
and theme critiques, but the newly calibrated reports no longer treat the accepted
geometry false positives as blockers when their declared evidence disproves them.

### v0.1.6 icon containment and stat emphasis

The equipped-icon safe area is now a hard deterministic geometry contract:
every icon must clear all four edges of its 64px paper-doll slot by at least 6px.
The real populated probe confirms Head, Neck, Main Hand, and Off Hand icons render
at 48px with 8px clearance. The visual-review setup declares the safe area and
icon bounds, so an icon escaping it produces a deterministic blocker.

Zero-valued stat text is always neutral. Green applies only when the effective
value and base value differ visibly, the effective value is positive, and the
base is non-negative; this prevents a displayed `0` from implying a gear bonus.

`files/visual-review/after/v0.1.6/equipment-hover-equipped.{png,review.json}`
captures the fixed equipped state with 24 declared regions and zero deterministic
blockers.

### Display-precision stat emphasis

Move Speed could be a small positive raw value (for example `0.0025`) while
rendering as `0.00`. The former implementation compared raw values and separately
formatted strings (`"0.00"` versus `"0"`), which incorrectly marked that visible
zero as a green bonus. The comparison now uses numeric values at the same precision
shown to the player. The real-Phaser e2e test explicitly asserts a rendered zero
Move Speed value remains neutral.

### v0.1.7 gear-only emphasis and stat units

The stats column now computes a separate no-equipment loadout using the canonical
effective-stat formula, then compares it against the currently equipped loadout.
Green text is reserved for a _visible positive delta caused by equipped gear_,
including a primary-stat bonus that produces a derived secondary effect. Baseline
primary-stat derivatives and unrelated active modifiers remain neutral.

Stat values now use their player-facing units: fractional bonuses render as
`N.X%`, critical multiplier renders as `N.NNx`, and labels use `XP`/`HP`.
The focused real-Phaser test proves both a neutral baseline and a green
Move Speed value after equipping Leather Boots, plus the unit/label contract.

All five tracked scenarios were recaptured and Azure-reviewed at:

`files/visual-review/after/v0.1.7/{equipment,equipment-hover-equipped,equipment-hover-duplicate,equipment-hover-empty-slot,equipment-hover-mixed-delta}.{png,review.json}`

Every v0.1.7 capture has zero deterministic geometry blockers. The Azure model
continued to offer subjective density/theme critiques and, for the duplicate
hover state, incorrectly described a gear-derived green value as a baseline
highlight. The declared state has Iron Helm equipped, so that green value is
the intended equipment attribution. The deterministic baseline comparison is
unchanged: v0.1.6 and v0.1.7 both pass the same 30 visual/interaction checks
with zero geometry blockers.

## Validation

- `npx vitest run tests/ecs/equip-delta-preview.test.ts` — 16 passed.
- `npm run test:e2e -- tests/e2e/inventory-flow.test.ts` — 25 passed.
- `npx vitest run tests/unit/visual-review-agent-cli.test.ts` — 19 passed.
- `npm run verify:fast` — passed (131 files, 1,818 tests).
- `npx vitest run tests/e2e/inventory-flow.test.ts -t "uses square labeled slots without an idle inspector"` — 2 passed across both e2e projects.
- `npx vitest run tests/e2e/inventory-flow.test.ts` — 52 passed across both e2e projects.
- `node --test scripts/agent/review/visual-review-lib.test.mjs` — 53 passed.
- `npx vitest run tests/unit/visual-review-agent-cli.test.ts` — 19 passed.
- `npm run review:visual:deterministic` — 30 passed.
- `npm run typecheck` — passed.
- `npx vitest run --project e2e tests/e2e/inventory-flow.test.ts -t "uses square labeled slots"` — passed.
- `npm run review:visual:deterministic` — 30 passed after the v0.1.6 changes.
- `npm run verify:fast` — passed after the v0.1.6 changes.
- `npx vitest run --project e2e tests/e2e/inventory-flow.test.ts -t "uses square labeled slots"` — passed after the display-precision fix.
- `npm run verify:fast` — passed after the display-precision fix.
- `npm run typecheck` — passed for the gear-only attribution and unit-format change.
- `npm run test:e2e -- -t "uses square labeled slots"` — passed for the
  gear-only attribution and unit-format change.
- `npm run review:visual:deterministic` — 30 passed for the v0.1.7 capture set.

## Systems touched

inventory, hud-ux, devtools, mcp-tooling

## Apple estimate

**Estimated:** 3🍎  
**Actual:** 3🍎

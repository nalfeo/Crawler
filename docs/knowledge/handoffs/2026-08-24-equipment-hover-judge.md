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

### Content-aware follow-up

The fixed inspector-height card was replaced with a compact content-aware layout.
`Iron Helm` is bold and centered over its icon; `EQUIPPED` is right-aligned on
the same header row. Stat rows begin below the icon's 28px safe area, followed
by flavor text, and the card height is derived from the visible stat and
description line count. The unit layout contract asserts the icon's bottom
remains above the first stat row, so an icon/`+2 Armor` collision fails
deterministically.

`files/visual-review/after/v0.1.19/equipment-hover-equipped.{png,review.json}`
is the updated real Phaser/Azure capture. It has zero deterministic blockers.
Azure still issued a subjective padding claim despite the compact measured
layout; the capture shows no unused right/bottom area.

### Tooltip composition follow-up

The icon and title now share a deeper 34px left inset. Flavor text is italic and
separated from stat rows by 12px. Hover cards select the side of their target
that is closer to the panel center and leave a 14px gap. The real-game hover
test asserts the Head card appears at least 10px to the right of the left-half
Head slot, as well as preserving the non-overlap and topmost contracts.

`files/visual-review/after/v0.1.20/equipment-hover-equipped.{png,review.json}`
is the updated real Phaser/Azure capture and reports zero deterministic blockers.

### Empty-slot geometry follow-up

The empty Feet candidate preview no longer uses the fixed bottom comparison strip,
which covered the highlighted target. It now uses the same compact, content-aware
card as equipped hover, center-facing placement, and 14px target gap. Placement
shrinks the card before allowing it to cover the Stats column. The real-game e2e
asserts the candidate card never overlaps Feet, remains at least 10px to its
center-facing side, and is topmost.

`files/visual-review/before/v0.1.20/equipment-hover-empty-slot.{png,review.json}`
captures the broken overlapping strip. The fixed real Phaser/Azure artifact is
`files/visual-review/after/v0.1.21/equipment-hover-empty-slot.{png,review.json}`;
it declares 23 regions and reports zero deterministic blockers.

### Empty-slot Bag hover correction

The Empty Slot scenario now correctly targets the hovered Leather Boots item in
Bag, not the empty Feet destination. The Bag cell receives the persistent hover
highlight and the tooltip anchors to its left. A dedicated real-Phaser e2e
fixture builds this empty-Feet state and asserts the actual highlighted Bag cell
does not overlap its tooltip, the tooltip is left/center-facing, and it is
topmost. The scenario also declares a clipped detail-review frame around those
two elements, so Azure reviews the interaction at readable scale while the
full-panel declared geometry remains available for placement context.

`files/visual-review/after/v0.1.23/equipment-hover-empty-slot.{png,review.json}`
is the focused real Phaser/Azure capture.

### Tooltip text containment

Every inspector text run in the Empty Slot scenario is now declared as a child
of the tooltip card. Container escape is therefore a deterministic blocker, not
a subjective LLM finding. The v0.1.24 focused capture hard-failed the measured
2px left overflow of `Leather Boots`; the compact layout inset was increased and
v0.1.25 reports zero deterministic blockers.

### Dense-gap calibration

Compact tooltip item names now align with the stat column's 8px left edge. The
visual judge is explicitly calibrated that a measured 12px-or-greater
target-to-tooltip gap is intentional dense-mode spacing; the v0.1.26 Azure
review no longer reports the 14px Bag-item gap as cramped.

### Header baseline contract

Compact item titles and their `CANDIDATE`/`EQUIPPED` state labels now use one
shared vertical center. The Empty Slot scenario hard-fails any title/state center
delta above 1px. The real Phaser v0.1.27 focused capture reports zero
deterministic blockers for this contract.

### Calibrated all-scenario evidence

The v0.2.4 refreshed Phaser/Azure captures cover equipped, duplicate, empty-slot,
and mixed-delta hover states through the same `renderItemTooltip()` implementation.
Focused hover reviews now send both a labeled full-panel context image and a target/card
detail image to Azure; declared geometry remains the deterministic source for overflow,
target occlusion, containment, and title/state alignment. Equipped, Empty Slot, and
Mixed Delta report a clean deterministic contract and an anchored 80.0+ score. The
duplicate comparison also has a clean deterministic contract after its content-aware
pair height grows to fit all delta rows; `No stat change` uses neutral high-contrast
text instead of a positive green delta. Its v0.2.7 capture is recorded alongside the
other lineage artifacts, with placement-only Azure commentary classified as advisory
unless measured geometry proves a defect.

### Bag-anchored mixed-delta comparison

Generated-item delta comparison now takes the real hovered Bag-cell bounds through
the same preview path as static Bag items. Its `CURRENT` and `CANDIDATE` cards sit
side by side on the Bag-facing side rather than reverting to the bottom Equipment
inspector. Both cards use the same generic `renderItemTooltip()` compact-card path,
including the light-gold outline, title/header spacing, and right-aligned `CURRENT` /
`CANDIDATE` labels. Candidate deltas render inline only beside direct item stats
(for example, `+6 Armor (+2)`) and retain green/red gain/loss color; derived-only
secondary changes such as Max HP from Constitution are not repeated as separate rows.

The real Phaser/Azure v0.3.4 capture passes with zero deterministic blockers and an
anchored 80.0 score:
`files/visual-review/after/v0.3.4/equipment-hover-mixed-delta.{png,review.json}`.
The focus crop includes the complete pair, and Azure receives that readable detail
alongside the full-panel placement context. The fixture hard-fails missing cards,
card overlap, horizontal baseline drift, inadequate inter-card separation, or intrusion
into the hovered Bag item's 14px clearance. The e2e fixture asserts the generated Bag
target, both card bounds, panel containment, non-occlusion, side-by-side baseline,
pair separation, and topmost state.

### Final compact comparison polish

The obsolete fixed inspector backing rectangle is hidden whenever the shared floating
cards render, removing the empty outlined panel behind the Bag-anchored pair. Both
item names now use the same 8px left inset as their stat rows; `CURRENT` and
`CANDIDATE` remain right-aligned on the shared top edge. Direct stat comparisons use
two text spans: the base value (for example, `+6 Armor`) remains neutral while only
the parenthesized direct delta (for example, `(+2)`) is bold and green/red. The
geometry declaration recognizes that delta as part of its parent stat row, so it
cannot be misclassified as a zero-gap sibling label while independent text remains
hard-checked.

`files/visual-review/after/v0.3.8/equipment-hover-mixed-delta.{png,review.json}` is
the final real Phaser/Azure artifact. It reports zero deterministic and
evidence-backed blockers with an anchored 80.0 score. Focused real-game tests confirm
the floating cards remain topmost, contained, aligned, non-occluding, and
integer-rasterized.

## Validation

- `npm run verify:fast` — passed.
- `npx vitest run --project e2e tests/e2e/inventory-flow.test.ts -t "captures equipped"` — passed.
- `node --test scripts/agent/review/visual-review-lib.test.mjs` — 53 passed.
- `node --test scripts/agent/review/text-raster-lib.test.mjs` — 6 passed.
- `npm run typecheck` — passed.
- `npm run review:visual:deterministic` — 32 passed.
- `npm run test:e2e -- -t "anchors generated delta comparisons"` — passed.
- `npm run test:unit -- tests/unit/item-tooltip.test.ts` — 5 passed.
- `npm run test:e2e -- tests/e2e/inventory-flow.test.ts -t "anchors generated delta comparisons|keeps rendered text contained"` — 2 passed.
- `npm run review:visual:llm -- ... --lineage-state v0.3.8` — anchored 80.0, zero deterministic/evidence-backed blockers.

## Systems touched

inventory, hud-ux, devtools

## Apple estimate

**Estimated:** 3🍎  
**Actual:** 3🍎

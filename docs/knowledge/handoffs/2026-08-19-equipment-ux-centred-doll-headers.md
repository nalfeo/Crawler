# Equipment UX: centred paper-doll and shared column header band (v5)

## Systems touched

engine

## Summary

Three layout corrections to the ten-slot equipment panel.

### 1. Paper-doll is vertically centred in its pane

The grid previously stretched to fill whatever height remained after the
inspector strip was subtracted, so the figure hugged the top of the doll frame
with a large dead band above the inspector. The grid is now sized by a capped
row pitch (`MAX_ROW_PITCH = 100`, three pitches across the four rows) and the
leftover height is split evenly above and below — mirroring how the X axis
already worked (`MAX_COL_PITCH` + `gridOffsetX`).

The bottom clearance is now an explicit named constant
(`INSPECTOR_GRID_CLEARANCE = 26`) matching the grid's `innerPadY` top inset, so
the centring maths is symmetric by construction rather than by coincidence.
This replaces the old `INSPECTOR_GAP` reservation, which was a magic number
subtracted from the usable height and did not describe an actual clearance.

### 2. "Stats" and "Bag" headings moved ABOVE their bounding boxes

Previously both rendered _inside_ their column frames while "Equipment"
rendered above the doll frame, so the three headings read as different kinds of
element. All three now share one header band:

- `columnHeadingTextY` / `columnHeadingFrameY` / `columnHeadingFrameH` are
  derived once and used by all three headings.
- The Stats and Bag frames start at `panelY + PANEL_PADDING + HEADER_BAND`
  (same y as the doll frame) instead of at the panel padding.
- Each heading frame now spans its full column width (`STATS_W` / `bagW`)
  instead of an ad-hoc 172px / `bagW - 20` box.

Downstream space reclaimed inside the frames: the stats compare banner moved
from `statsY + 58` to `statsY + 20`, the first stat row from `statsY + 74` to
`statsY + 36`, and the bag grid's reserved `headerH` from 48px to 14px.

### 3. Text-containment probe follows the headings

The deterministic e2e gate asserts every text run stays inside the region it is
tagged with. Because the Stats/Bag headings now lay out in the header band, they
are reported as `header` runs while remaining pooled with their column so they
still clear on re-render. `columnHeadingObjects` tracks them and `clearPool`
drops stale entries, so the set cannot leak across renders.

## Verification

- `npx vitest run --project e2e tests/e2e/inventory-flow.test.ts` — 25/25
  passed at both 1280×800 and 960×600 (slot bounds/non-overlap, filters,
  preview targets, unequip, ring-slot cues, text containment and collision).
- `npx tsc --noEmit` — no new EquipmentUI errors.
- Azure LLM visual judge (real Phaser `ui-probe-lab`, viewport 1280×800):
  **3.0/5**, unchanged from the prior committed round and still above the
  `main` baseline of 2.0/5. Confirmed by eye in the capture that all three
  requested fixes landed: headers aligned in one band, ring slots level with
  their row siblings, doll block centred.

Remaining judge findings (thematic empty-slot art, tooltip interior padding,
stat-label truncation) are recurring polish-tier items that pre-date this
round and are not regressions.

## Durable A/B evidence

| State                | Score | Paths                                                            |
| -------------------- | ----- | ---------------------------------------------------------------- |
| before / main        | 2.0/5 | `files/visual-review/before/main/equipment.png` + `.review.json` |
| after / v3           | 3.0/5 | `files/visual-review/after/v3/equipment.png` + `.review.json`    |
| after / v4           | 3.0/5 | `files/visual-review/after/v4/equipment.png` + `.review.json`    |
| after / v5 (current) | 3.0/5 | `files/visual-review/after/v5/equipment.png` + `.review.json`    |

## Non-goals preserved

Ten-slot contract (`EQUIPMENT_UI_SLOT_IDS`) unchanged. No equipment rules, item
definitions, persistence, loot, stats, or weapon behavior changed.

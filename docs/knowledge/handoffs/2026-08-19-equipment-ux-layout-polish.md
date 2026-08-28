# Equipment UX layout polish (v4)

## Systems touched

engine

## Summary

Follow-up layout polish round on the ten-slot equipment panel, addressing:

1. **Ring slot vertical misalignment / top-row overlap** — removed the ad-hoc
   per-slot `slotYOffset` hack (`+10` for gloves/legs, `-10` for
   feet/ring1/ring2) in `renderSlots()`. That offset put `ring1` (sharing the
   top row with head/neck) and `ring2` (sharing the bottom-middle row with
   gloves/legs) out of alignment with their row siblings — a 20px mismatch on
   the gloves/legs/ring2 row. Slots are now placed purely by row (`py`), so
   every slot on the same row is visually level. Increased `innerPadY` from
   10px to 26px so the top row clears the doll's inset border with real
   margin instead of nearly touching it.
2. **Header consistency** — "Stats" and "Bag" headings now match "Equipment"'s
   style: 18px font (was 16px), `textPrimary` color (was `accent`), and the
   same `0x355180` frame fill (was `COLORS.sectionHeader`).
3. **Paper-doll compactness** — `DOLL_W` reduced 470→390, `innerPadX` 22→18,
   `MAX_COL_PITCH` 155→125, tightening the grid and recentering it in less
   width.
4. **Bag panel horizontal padding** — reduced by shrinking overall panel width
   (see below), which shrinks `bagW` proportionally since it's computed as
   the remainder of panel width after the doll/stats columns.
5. **Overall panel width** — default `panelWidth` reduced 1240→1080 (height
   unchanged at 720, since a height reduction broke the stats/inspector row
   budget — see fix below).

### Follow-on fixes required to keep everything green

- Stats "Status" row text overflowed at 1280×800 after the initial panel
  height reduction to 660 — reverted panel height back to 720 and instead
  nudged `compareBarY` (52→58) and `rowY` start (68→74) down slightly so the
  compare banner and first stat row don't collide, which the initial
  960×600 pass caught.
- Tooltip/inspector strip was pushed too close to the (now higher, since
  `innerPadY` grew) Feet slot: increased `INSPECTOR_GAP` 52→62 and
  `INSPECTOR_H` 96→100 (adds the previously-requested extra bottom padding),
  and moved the inspector's bottom margin 50→42 to restore clearance from
  Feet's label band.

## Verification

- `npx vitest run --project e2e tests/e2e/inventory-flow.test.ts` — 25/25
  passed (covers slot bounds/non-overlap, filters, preview targets, unequip,
  ring-slot cues, and per-viewport text containment/collision checks at
  1280×800 and 960×600).
- `npx tsc --noEmit` — no new EquipmentUI errors (pre-existing unrelated
  `functions/dev-build-ingest` failures only).
- Azure LLM visual judge (`npm run review:visual:llm`, real Phaser lab via
  `ui-probe-lab`), viewport 1280×800: **3.0/5**, same as the prior committed
  baseline and still above the `main` baseline of 2.0/5. Remaining findings
  (tooltip breathing room, empty-slot thematic affordance, decorative
  texture) are polish-tier and do not regress the gate.

## Durable A/B evidence

- Before/main: **2.0/5**, `files/visual-review/before/main/equipment.png`,
  `files/visual-review/before/main/equipment.review.json`
- After/v3 (prior round): **3.0/5**, `files/visual-review/after/v3/equipment.png`,
  `files/visual-review/after/v3/equipment.review.json`
- After/v4 (this round): **3.0/5**, `files/visual-review/after/v4/equipment.png`,
  `files/visual-review/after/v4/equipment.review.json`

## Non-goals preserved

Ten-slot contract (`EQUIPMENT_UI_SLOT_IDS`) unchanged. No equipment rules,
item definitions, persistence, loot, stats, or weapon behavior changed.

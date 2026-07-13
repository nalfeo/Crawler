# Navigation HUD polish

**Date:** 2026-07-13
**Persona:** UX Designer
**Apples:** 3 estimated -> 3 actual

## Systems touched

hud-ux, mobile-ux, quests

## Summary

- Unified the quest tracker, docked minimap, fullscreen map, and direction arrows
  behind shared responsive navigation layout and reservation geometry.
- Restyled navigation chrome in the EquipmentUI/InventoryUI blue-steel pixel
  language while preserving minimap controls, tracker collapse, and touch targets.
- Wrapped and bounded crowded quest content; arrow labels preserve long objective
  copy across two lines and compact long distances.
- Fanned simultaneous arrows around critical HUD, radar, tracker, and Floor 2 family
  panel bounds.
- Suppressed docked navigation while the fullscreen map is open.
- Added a real-HUD stress probe plus deterministic unit and browser regressions for
  Floor 1/2, docked/fullscreen, 1280x720, and 844x390 states.

## Verification

- `npm run verify:fast` - 63 affected unit tests passed.
- `npx vitest run --project e2e tests/e2e/navigation-hud-layout.test.ts` - 5/5 passed.
- All eight stressed viewport/floor/mode combinations reported zero deterministic
  clipping or overlap.
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-13-navigation-hud-polish.review-ledger.json`
- `npm run verify:pr-prereqs`

## Visual review

- Before/after captures are under the session artifact directory
  `files/navigation-hud/`.
- Final docked reports:
  - `files/visual-review/navigation-hud-iter6-docked-desktop-2026-07-13T05-45-24-281Z.review.json`
  - `files/visual-review/navigation-hud-iter6-docked-mobile-2026-07-13T05-46-15-036Z.review.json`
- Final fullscreen reports:
  - `files/visual-review/navigation-hud-iter7-fullscreen-desktop-2026-07-13T05-53-36-726Z.review.json`
  - `files/visual-review/navigation-hud-iter7-fullscreen-mobile-2026-07-13T05-54-28-220Z.review.json`

The deterministic visual layer reports zero blockers. The LLM visual layer reached
an evidence-backed deadlock after seven iterations: it repeatedly reported overlaps
for non-intersecting declared rectangles, claimed the mobile fullscreen map lacked a
title while `DUNGEON MAP` was visibly rendered, and oscillated the close-button
vertical recommendation from +4px to -2px to +4px. Exact actionable spacing deltas
were applied before stopping; contradictory requests were not allowed to oscillate
the proven accessible layout.

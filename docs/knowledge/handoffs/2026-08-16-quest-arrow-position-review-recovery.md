# Handoff: Quest arrow position review recovery

## Systems touched

hud-ux, quests

## What changed

- Kept the direction-locked arrow fan range, while refusing to place an arrow in
  a reserved HUD region or on another arrow when no valid candidate exists.
  An entirely blocked or crowded arrow is omitted.
- Corrected the shallow up-right unit fixture so it reaches the right-edge
  `sin` slide branch.
- Added deterministic MainGameScene browser coverage for omission in reserved
  regions and the rendered side, edge, and rotation of crowded down-right
  arrows.

## Observation

- Before the repair, the review fixture could exhaust its locked candidates and
  commit a known HUD-colliding endpoint; the previous right-edge fixture actually
  projected to the top edge.
- After the repair, `tests/e2e/quest-waypoint-arrows.deterministic.test.ts`
  observed the real MainGameScene render only show HUD-safe arrows and keep
  crowded down-right arrows on the lower half of the right edge, right of centre, with
  down-right rotation.

## Validation

- `npx vitest run --project unit tests/unit/hud-direction-arrows.test.ts --reporter=verbose`
- `npx vitest run --project e2e tests/e2e/quest-waypoint-arrows.deterministic.test.ts --reporter=verbose`
- `npm run typecheck`
- `npm run lint:engine`

## Apples

Estimated 2🍎; actual 3🍎 (📉 Under) because closing the renderer-observation
review finding required a typed MainGameScene probe seam in addition to the
placement fix and unit regressions.

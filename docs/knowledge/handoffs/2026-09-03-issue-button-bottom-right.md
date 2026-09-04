# Issue button bottom-right safe-area anchoring

## Systems touched

hud-ux, mobile-ux

## Outcome

The real MainGameScene Issue button is independently anchored to the
bottom-right safe-area rectangle with the existing 16px margin at both
supported landscape viewports. It no longer joins the left corner-button
column or jumps to the top-right when a panel opens. Its elevated panel depth
and existing picker/cancel behavior are preserved.

## Evidence

- Before: the Issue button was appended to the left corner-button stack at
  normal scale, moved beside that stack at larger UI scales, and moved to the
  top-right while panels were open.
- After: deterministic real MainGameScene probes passed at 1280x720 and
  960x540, asserting the Issue bounds stay inside the bottom-right safe-area
  margin and clear the skill HUD and interaction hint.
- The real MainGameScene UI exclusivity suite passed its inventory click-through
  and picker cancellation coverage, including preservation of the underlying
  inventory and pause state.

## Validation

- `npm run typecheck`
- `npm run test:unit -- --run tests/unit/main-game-scene-corner-button-icons.test.ts`
- `npm run test:e2e -- --run tests/e2e/hud-vitals-stack-corner-buttons.deterministic.test.ts tests/e2e/main-game-scene-ui-exclusivity.test.ts`
- `npm run verify:fast`

## Complexity

Estimated: 2 apples. Actual: 2 apples.

# Handoff: mobile UI touch transition recovery

## Systems touched

mobile-ux, hud-ux

## Apples

Estimated: 2. Actual: 2. 🎯 Exact — input lifecycle repair with real-scene regression coverage.

## Summary

- Clear captured input when a blocking surface changes state and when corner-button toggles queue.
- Replaced the source-text regression assertion with CDP held-touch checks for Inventory, Equipment, dialogue, and Quartermaster surfaces.

## Observation

- Before: a touch held through a blocking surface close could resume movement or interaction after the panel disappeared.
- After: real `MainGameScene` browser tests keep player position and conversation state unchanged while each covered surface is held and closed.

## Verification

- `npm run typecheck`
- `npm run test:unit -- tests/unit/main-game-scene-mobile-ui.test.ts`
- `npm run test:e2e -- tests/e2e/main-game-scene-ui-exclusivity.test.ts`
- `npm run verify:fast`
- `runtime-tools-secret_scanning`

## Unresolved issues

- None.

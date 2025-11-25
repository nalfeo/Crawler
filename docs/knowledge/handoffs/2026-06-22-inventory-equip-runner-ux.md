# Handoff — 2026-06-22 — inventory-equip-runner-ux

**Persona:** Producer (cross-layer UX fix spanning scene flow, runner lab wiring, and regression tests)

## Summary

Fixed the Floor 1 bag/equip UX so paused safe-room scenes still process the Bag/Gear controls, and updated the AI Runner Lab to visibly route the merchant charm through the real inventory/equip flow instead of silently equipping it behind the curtain.

## What Was Done

1. **MainGameScene feature-unlock input now works in paused/non-sim branches**
   - Added public scene hooks for `requestInventoryToggle()`, `requestEquipAction()`, and `isInventoryOpen()`.
   - Ran `updateFeatureUnlocks()` in the paused / conversation / HUD overlay / loadout / non-`playing` render branches so queued Bag/Gear inputs are still handled when the simulation is frozen but the UX is on-screen.
   - This fixes the “Bag button does nothing” regression in the visual runner’s paused safe-room state.

2. **AI Runner Lab now shows the inventory/equip UX for the merchant charm**
   - Stopped the lab from directly calling the shopkeeper equip bypass.
   - Kept the merchant purchase on the existing modal path, then added a short deterministic inventory preview hold.
   - After purchase, the lab explicitly opens the bag, leaves it visible briefly, then triggers the real equip action through the scene hook.

3. **Regression coverage**
   - Added `tests/unit/ai-shopkeeper-ux-wiring.test.ts` to guard:
     - paused-scene feature-unlock handling in `MainGameScene`
     - AI Runner Lab inventory-preview + equip-hook wiring
     - absence of the old direct equip bypass

## Validation

- `npm run verify:fast` ✅
- `npm run verify` ✅
- `npx vitest run tests/unit/ai-shopkeeper-ux-wiring.test.ts tests/game/floor1-scenario.test.ts --reporter=dot` ✅

## Apples

- Estimated: 🍎🍎🍎
- Actual: 🍎🍎🍎
- Verdict: 🎯 Exact
- Hello kitties: 0.60

## Systems touched

inventory

## Notes

- No ADR needed: this was a targeted UX/wiring repair, not a new multi-system architecture decision.

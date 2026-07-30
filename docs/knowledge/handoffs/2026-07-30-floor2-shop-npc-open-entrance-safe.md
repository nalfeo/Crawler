# Handoff: Floor 2 shops open via NPC interaction; entrance safe room

## Date

2026-07-30

## Persona

UX Designer implementation with policy-required review ledger.

## Systems touched

hud-ux, inventory, mapgen

## Apples

2 apples estimated, 2 apples actual.

## Summary

- Removed the closed-state Floor 2 Shop button opening path in `MainGameScene`.
- Preserved the selected settlement shop identity so interacting (`Talk`) with:
  - the Quartermaster NPC opens Quartermaster generated stock, and
  - non-Quartermaster settlement shop NPCs open the same shared panel, but now
    render and purchase from that NPC's own seeded `Floor2ShopInstance.inventory`.
- Added a small `settlement-shop-purchase` read/purchase seam and reused the
  existing shop panel UX instead of creating a separate shop-specific surface.
- Kept quartermaster panel toggle only as an open-state dismiss affordance.
- Updated safe-space classification so Floor 2 spawn-room tiles count as safe context.
- Preserved settlement anchor behavior (`resolveFloor2SettlementAnchor`) by keeping it keyed to persisted settlement room id.
- Added/updated targeted tests for:
  - NPC-interaction-based shop opening,
  - non-Quartermaster shop interaction opening and inventory routing,
  - hidden closed-state shop button expectation,
  - settlement-shop purchase mutation, and
  - Floor 2 entrance safe-room classification plus settlement-anchor stability.

## Files touched

- `src/engine/scenes/MainGameScene.ts`
- `src/core/safe-space.ts`
- `src/core/settlement-shop-purchase.ts`
- `src/engine/QuartermasterUI.ts`
- `src/shared/equipmentDefs.ts`
- `src/labs/main-scene-probe-lab/index.ts`
- `tests/e2e/helpers/main-scene-probe.ts`
- `tests/e2e/main-game-scene-quartermaster.test.ts`
- `tests/unit/settlement-shop-purchase.test.ts`
- `tests/unit/floor2-scenario-initialization.test.ts`
- `docs/knowledge/adr/2026-07-30-floor2-shop-interaction-and-entrance-safe-room.md`
- `docs/knowledge/review-ledgers/2026-07-30-floor2-shop-npc-open-entrance-safe.review-ledger.json`

## Validation

- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-30-floor2-shop-npc-open-entrance-safe.review-ledger.json` ✅
- `parallel_validation` ✅ (no review comments; CodeQL run returned 0 alerts, but scan noted database-size skip)
- `npm run typecheck:src` ✅
- `npx vitest run tests/unit/settlement-shop-purchase.test.ts tests/unit/floor2-scenario-initialization.test.ts --project unit` ✅ (21/21)
- `npx vitest run tests/e2e/main-game-scene-quartermaster.test.ts --project e2e` ✅ (9/9)
- `npm run verify:fast` ✅
- `npm run verify:pr-prereqs` ✅

## Runtime / observe-before-done

- **Before (real game, `npm run dev`, `http://127.0.0.1:4173/?floor=floor2`, temporary local checkout of pre-fix files from `9d30add`):**
  - `isInSafeContext(world)` at the Floor 2 entrance returned `false`.
  - Interacting with the Quartermaster NPC did **not** open the shop panel.
  - Interacting with a non-Quartermaster settlement shop NPC did **not** open the shop panel.
- **After (real game, same `npm run dev` route on restored head):**
  - `isInSafeContext(world)` at the Floor 2 entrance returned `true`.
  - Interacting with the Quartermaster NPC opened the shared shop panel.
  - Interacting with a non-Quartermaster settlement shop NPC opened the same panel, and purchasing from it decremented that NPC's own seeded stock (`1 → 0`) in the live `world.floorExtendedState.settlement.shops[0].inventory`.
- Supporting deterministic coverage now passes in the real-scene e2e harness (`tests/e2e/main-game-scene-quartermaster.test.ts`).

## Unresolved issues / follow-up

1. Keep the shared panel naming/wording aligned if future settlement shops need stronger per-archetype branding than the current title swap.

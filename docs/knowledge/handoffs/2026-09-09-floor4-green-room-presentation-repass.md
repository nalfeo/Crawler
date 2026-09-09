# Floor 4 Green Room presentation repass

## Systems touched

floor4-arena, main-game-scene, shop-panel, e2e

## Apples

4 estimated, 4 actual. This repass closed the remaining production-presentation
acceptance gap after review.

## Change

Added a deterministic MainGameScene probe fixture for the authored Floor 4
intermission marker and a real-scene regression that delivers the marker
interaction, opens the shared ShopPanelUI, activates its focused Buy control,
and verifies wallet, inventory, stock, purchase-count, and vendor-ledger
changes. The fixture only arranges the live world at an intermission; it does
not implement a runner-only purchase or phase shortcut.

## Verification

- `npm run typecheck`
- `npx vitest run --project e2e tests/e2e/floor4-green-room-shop.deterministic.test.ts`
- `npx vitest run --project unit tests/unit/floor4-green-room-stock.test.ts tests/unit/floor4-arena-director.test.ts tests/unit/floor4-arena-map.test.ts`
- `npx vitest run --project headless tests/headless/floor4-arena-completion.test.ts`
- `bash scripts/agent/verify-fast.sh`

## Real-pipeline evidence

The deterministic browser test boots the shipped `createFloorMainSceneOptions`
and `MainGameScene`, places the player at the authored Green Room marker,
delivers the production interaction handler, and purchases using the shared
panel's keyboard activation path. The existing seed-404 headless gate remains
green for all five acts and deterministic replay.

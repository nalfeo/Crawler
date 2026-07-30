# Handoff: InventoryBag review-thread recovery

**Date:** 2026-07-30  
**Session slug:** inventorybag-review-recovery  
**Issue/PR:** nalfeo/Crawler#2365  
**Apple estimate:** 2🍎

## Systems touched

inventory, hud-ux, ci-policy

## What was done

- Replaced the selector-only InventoryBag lane lint with a dedicated custom ESLint rule in
  `tools/eslint-rules/inventorybag-lane-access.js`, then wired it into `eslint.config.js`.
- Closed the cited `world.inventories.get(...)!.slots` escape hatch by migrating
  `tests/integration/floor-transition-carryover.test.ts` to `addItem(...)`.
- Updated the real `src/engine/InventoryUI.ts` render path to project from
  `listInventoryEntries(...)`, resolve generated entries through the world registry, include them
  in tab/filter/signature/count rendering, and pass generated entries through the existing
  `equipFromBag(...)` overload.
- Widened the InventoryUI equip callback plumbing in `src/engine/scenes/MainGameScene.ts` and
  `src/labs/ui-probe-lab/index.ts` so the renderer can request generated-entry equips.
- Added regression coverage for:
  - the custom lint rule (`tests/unit/inventorybag-lane-access-rule.test.ts`);
  - a generated-only bag rendering through the real Inventory UI headless path
    (`tests/integration/inventory-ui-item-art.test.ts`).
- Added ADR `docs/knowledge/adr/2026-07-30-inventorybag-accessor-contract.md` to document the
  cross-layer contract.

## Files touched

- `eslint.config.js`
- `tools/eslint-rules/inventorybag-lane-access.js`
- `src/engine/InventoryUI.ts`
- `src/engine/scenes/MainGameScene.ts`
- `src/labs/ui-probe-lab/index.ts`
- `tests/integration/floor-transition-carryover.test.ts`
- `tests/integration/inventory-ui-item-art.test.ts`
- `tests/unit/inventorybag-lane-access-rule.test.ts`
- `docs/knowledge/adr/2026-07-30-inventorybag-accessor-contract.md`
- `docs/knowledge/review-ledgers/2026-07-30-inventorybag-review-recovery.review-ledger.json`

## Verification

- Separate-model review-thread validation:
  - `lint-thread-validator` (`claude-sonnet-5`) → still valid
  - `inventory-ui-validator` (`claude-sonnet-5`) → still valid
- `npm run review:ledger -- init --apples 2 --slug inventorybag-review-recovery --title "InventoryBag review-thread recovery"` ✅
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-30-inventorybag-review-recovery.review-ledger.json` ✅
- `npm run verify:pr-prereqs` ❌ before adding this handoff/ADR/ledger; rerun still pending after paperwork
- Local lint/type/test/format commands remain blocked in this sandbox because the checkout has an
  empty `node_modules/` directory and the networked install path fails during preflight/npm
  dependency resolution

## Unresolved issues

- Full local `verify:fast` / lint / Vitest coverage was not rerunnable in this sandbox because the
  required project binaries (`prettier`, `eslint`, `vitest`, `typescript`) are unavailable locally.

## Recommended next steps

- Re-run `npm run verify:pr-prereqs` now that the ledger, ADR, and handoff exist.
- Let CI exercise the authoritative lint/type/test gates for the branch.
- If CI or review finds additional generated-entry UX gaps, promote the render projection helper
  into a shared/view-model seam rather than reintroducing raw bag-lane reads.

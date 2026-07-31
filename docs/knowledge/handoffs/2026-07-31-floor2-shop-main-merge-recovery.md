# Handoff: Floor 2 shop main-merge recovery

**Date:** 2026-07-31  
**Session slug:** floor2-shop-main-merge-recovery  
**Apple estimate:** 🍎🍎

## Summary

Recovered PR #2373 from the current `main` merge-conflict blocker.

- merged `origin/main` into `copilot/fix-shop-interaction-ux`
- resolved the only real content conflict in `src/labs/main-scene-probe-lab/index.ts`
- preserved the branch's shared settlement-shop purchase path instead of reverting to the older quartermaster-only probe purchase logic
- extended `MainGameScene.purchaseFirstSettlementShopOffer()` to surface the generated `instanceId` for quartermaster-backed purchases so the merged exact-instance e2e assertions stay valid

## Systems touched

hud-ux, mapgen

## Validation

- `npx vitest run tests/e2e/main-game-scene-quartermaster.test.ts` ✅
- `npm run verify:fast` ✅
- `npm run verify:pr-prereqs` ✅
- `parallel_validation` ✅ (Code Review clean; CodeQL returned 0 alerts / skipped large JS database)

## Notes

- The sandbox could not resolve `ms-feed-*.pkgs.visualstudio.com` tarball URLs from `package-lock.json`. For verification only, those tarball hosts were temporarily rewritten to `registry.npmjs.org`, `npm ci --ignore-scripts` was run, and `package-lock.json` was restored immediately afterward.
- Because install scripts were skipped, Playwright Chromium was installed explicitly with `npx playwright install chromium` before rerunning the targeted e2e suite.

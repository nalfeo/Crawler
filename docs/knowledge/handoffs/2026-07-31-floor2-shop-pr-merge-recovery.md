# Handoff: Floor 2 shop PR merge recovery

**Date:** 2026-07-31  
**Session slug:** floor2-shop-pr-merge-recovery  
**Apple estimate:** 🍎🍎

## Summary

Recovered PR #2373 from the blocking `Silent Merge-Revert Guard` failure.
The repair was intentionally surgical:

- restored `tests/unit/generated-asset-registry.test.ts` to `origin/main`
- restored `tests/unit/weapon-anchor-resolver.test.ts` to `origin/main`
- kept the Floor 2 shop/safe-room implementation untouched
- verified the committed tree no longer contains the blocking mainline silent
  reverts that CI was reporting

## Systems touched

sprite-workflow, weapons

## Validation

- `npx vitest run tests/unit/generated-asset-registry.test.ts tests/unit/weapon-anchor-resolver.test.ts --project unit` ✅
- `SILENT_REVERT_BASE_REF=origin/main npm run check:silent-reverts` ✅ (0 blocking findings; 2 branch-local warnings remain)
- `npm run verify:fast` ✅
- `npm run verify:pr-prereqs` ✅

## Notes

- Local `npm ci` initially failed because a subset of `package-lock.json`
  tarballs resolved through unreachable `ms-feed-*.pkgs.visualstudio.com`
  hosts in this sandbox. For verification only, those URLs were temporarily
  rewritten to `registry.npmjs.org`, `npm ci --ignore-scripts` was run, and the
  original lockfile was restored before continuing.
- The silent-revert guard still reports two **non-blocking branch-local**
  warnings (`src/shared/mirror-slot-metadata.ts`,
  `tests/unit/sprites/theme-equipment-review-cli.test.ts`), but the guard
  explicitly reports **no surviving silent reverts** against `origin/main`.

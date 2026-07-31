# Handoff: InventoryBag CI recovery follow-up

**Date:** 2026-07-30  
**Session slug:** inventorybag-ci-recovery-followup  
**Issue/PR:** nalfeo/Crawler#2365  
**Apple estimate:** 2🍎

## Systems touched

inventory, engine, sprites, ci-policy

## What was done

- Restored `InventoryUI.getVisibleItemIds()` so the main-scene probe can observe rendered inventory contents again.
- Fixed generated inventory rendering to fall back to the authoritative frozen generated-instance snapshot when a generated base is not present in the static item catalog; this restored achievement, quartermaster, and boss-chest acquisition visibility.
- Tightened `test-only-exports` so `src/labs/**` never counts as production evidence, and added focused regression coverage for the guard's base-snapshot behavior plus underscore-prefixed explicit test seams.
- Deleted the unused `src/shared/mirror-slot-metadata.ts` dead file and moved mirror-slot tooling consumers onto explicit underscore test-seam exports in `src/shared/equipment-slots.ts`.

## Files touched

- `src/engine/InventoryUI.ts`
- `scripts/agent/health/test-only-exports-lib.ts`
- `scripts/sprites/theme-equipment-set.ts`
- `scripts/sprites/theme-roster-synth.ts`
- `src/shared/equipment-slots.ts`
- `src/shared/index.ts`
- `src/shared/mirror-slot-metadata.ts` (deleted)
- `tests/unit/agent/test-only-exports.test.ts`
- `tests/unit/equipment-slots.test.ts`
- `tests/unit/sprites/theme-equipment-set.test.ts`
- `tests/unit/sprites/theme-roster-synth.test.ts`

## Verification

- `npm run check:test-only-exports` ✅
- `npm run lint:dead-code` ✅
- `npx vitest run --project unit tests/unit/agent/test-only-exports.test.ts tests/unit/equipment-slots.test.ts` ✅
- `npx vitest run --project sprites tests/unit/sprites/theme-equipment-set.test.ts tests/unit/sprites/theme-roster-synth.test.ts` ✅
- `npx vitest run --project e2e-game tests/e2e/main-game-scene-quartermaster.test.ts` ✅
- `npm run verify:fast` ✅
- `npm run verify:pr-prereqs` ✅

## Notes

- Local package-backed verification required a temporary, uncommitted `package-lock.json` host rewrite away from the sandbox-inaccessible `ms-feed-*.pkgs.visualstudio.com` mirrors; the original lockfile was restored before staging changes.
- No `files/guard-telemetry.jsonl` artifact existed in this session.

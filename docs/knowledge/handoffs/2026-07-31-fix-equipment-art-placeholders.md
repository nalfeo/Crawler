# Handoff: Fix equipment art placeholders

**Date:** 2026-07-31  
**Session slug:** fix-equipment-art-placeholders  
**Branch:** nalfeo-fix-equipment-art-placeholders

## Systems touched

inventory, weapons, sprite-pipeline

## Summary

Fixed generated equipment icon resolution so wiring-entry art and legacy
slug-versioned art now resolve for Floor 2 items in all production cases.

**Root cause:** The `getFloor2SlugToRuntimeKey` helper indexed by bare slug only
(e.g. `moon-scythe`). Production Floor 2 item IDs are stableIds
(e.g. `weapon.moon-scythe`, `torso.chain-hauberk`). Neither Wave B weapon IDs
(where `id === weaponId === stableId`) nor non-weapon gear IDs could hit the
slug-only map, so all production Floor 2 items fell through to text placeholders.
Wave A items (`weapon.iron-cleaver`) also missed because their equipment defs are
not registered in `getEquipmentDefForItem`, so the `weaponId` bridge doesn't apply.

**Fix:** Extended the map to index by both slug AND stableId. Also extended
`itemSpriteConcepts` to push the bare slug (derived from the runtimeKey's last
path segment) into the concept list so that legacy versioned entries keyed by slug
(e.g. `chain-hauberk-v3-var-*`) are still found when no wiring entry exists. The
wiring entry (TIER_BARE_REAL) wins over the legacy versioned entry (TIER_VERSIONED_REAL)
when both exist.

The original lab screenshots used slug-format IDs (`moon-scythe`), which happened to
hit the slug map. The fix now also covers the production stableId path which was
the actual broken path.

## Files touched

- `src/shared/item-sprites.ts`
- `tests/unit/item-sprites.test.ts`

## Verification

- `npm run verify:fast` — passes
- Unit tests now exercise production stableId-format IDs (`weapon.moon-scythe`,
  `weapon.iron-cleaver`, `torso.chain-hauberk`) rather than bare slugs. All 36
  tests pass and cover: stableId → runtimeKey resolution, stableId → legacy-slug
  fallback, wiring-over-legacy priority, and the Floor 1 `bone-club` → `baseball-bat`
  weaponId bridge.
- Visual verification of the slug-format path (lab screenshots) remains in
  session artifacts `before-fix-demo.png` / `after-fix-demo.png`. Production
  stableId resolution is verified deterministically through the unit tests; a
  headless or in-game visual sweep over Floor 2 equipment UIs is deferred to CI.

## Unresolved issues

None.

## Next steps

Open the PR, then let CI and review handle the merge path.

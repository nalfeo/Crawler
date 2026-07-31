# Handoff: Fix equipment art placeholders

**Date:** 2026-07-31  
**Session slug:** fix-equipment-art-placeholders  
**Branch:** nalfeo-fix-equipment-art-placeholders

## Systems touched

inventory, weapons, sprite-pipeline

## Summary

Fixed generated equipment icon resolution so wiring-entry art now wins everywhere
equipment is rendered. The sprite matcher now treats Floor 2 runtime keys as
additional lookup concepts, which lets approved art like
`equipment/weapon/moon-scythe` resolve instead of falling back to text
placeholders.

## Files touched

- `src/shared/item-sprites.ts`
- `tests/unit/item-sprites.test.ts`

## Verification

- `npm run verify:fast`
- In-game before/after screenshots captured from the lab UI and saved in the
  session artifacts folder:
  - `before-fix-demo.png`
  - `after-fix-demo.png`

## Unresolved issues

None.

## Next steps

Open the PR, then let CI and review handle the merge path.

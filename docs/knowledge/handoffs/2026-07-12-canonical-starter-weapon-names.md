# Canonical starter weapon names

**Date:** 2026-07-12  
**Persona:** Game Designer  
**Apples:** Estimated 🍎🍎 · Actual 🍎🍎 · 🎯 exact

## Systems touched

weapons, inventory, sprite-pipeline

## Summary

- Kept the canonical six-weapon Floor 1 pool and deterministic three-choice sampling.
- Made `throwing-knife` and `fireball` the inventory, equipment, shop, and art-plan
  identities as well as the combat IDs.
- Removed the retired shiv and flare-gun aliases from active code, data, scripts,
  and tests.
- Retired the mismatched shiv placeholder and three approved wand art variants
  instead of relabeling them as different weapons.
- Added a unit invariant that the Throwing Knife and Fireball starter IDs map to
  same-ID inventory equipment with matching player-facing names.

## Runtime observation

- Before: the shipped inventory/equipment catalog mapped the `throwing-knife`
  combat starter to a shiv item and the `fireball` combat starter to a flare-gun
  item; their mismatched item art was present in the generated manifest.
- After: the real Floor 1 headless pipeline initialized seed 42 with forced
  `throwing-knife` and forced `fireball` starters. Both runs reported the
  canonical ID as `Starting Wep`; the old item aliases and art entries no longer
  exist in active paths.

## Verification

- `npm run verify:fast`
- Active-tree retired-name search returned no matches.
- Generated manifest and sprite catalog parse as valid JSON.

## Follow-up

- Generate and approve new canonical item icons for `throwing-knife` and
  `fireball`; inventory rendering uses its normal fallback until those assets
  land.

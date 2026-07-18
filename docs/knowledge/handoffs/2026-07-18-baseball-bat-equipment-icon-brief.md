# Handoff: baseball-bat Floor 2 Equipment Icon Brief

## Date

2026-07-18

## Persona

Graphics Designer

## Systems touched

sprite-pipeline

## Apples

1🍎 exact — pure art task: brief authoring. No code changes.

## What Was Done

Handled issue #1329 (canonical; #1435 was a duplicate closed by the maintainer) for the
`baseball-bat` Floor 2 equipment icon:

1. **Brief authored**: Created `briefs/weapons/baseball-bat.yaml` with the issue description
   (centered, silhouette-readable bludgeon weapon; standard wooden baseball bat held vertically;
   thick barrel at top, narrow grip/knob at bottom; no glow/enchantment; clear bludgeon
   silhouette at a glance). Runtime key `equipment/weapon/baseball-bat` per the Floor 2
   equipment stable manifest (`weapon.baseball-bat` stable ID, canonical key = first `.`
   replaced with `/`).

2. **Existing approved art confirmed**: `baseball-bat-v1-var-0.png` (sensorScore 8/8,
   judgeScore 2, type: weapon, approved 2026-06-30) is already in
   `public/assets/generated/` and `src/shared/data/sprite-catalog.json`. The sprite is
   currently the runtime asset for the `bone-club` inventory item (Baseball Bat) via the
   `weaponId: 'baseball-bat'` mapping in `equipmentDefs.ts`.

3. **Wiring verified**: The `resolveItemSprite` path in `src/shared/item-sprites.ts`
   correctly resolves `bone-club → baseball-bat → baseball-bat-v1-var-0` through the
   `itemSpriteConcepts` function. The EquipmentUI and InventoryUI already pick up this
   sprite. No code wiring changes needed.

4. **verify:fast passed**: 4254 tests pass. One pre-existing failure
   (`epic-status.test.ts` shallow-clone rev-parse, unrelated to this change).

## Key Decisions Made

- **Did not regenerate in this PR**: The existing approved art passed 8/8 sensors.
  judgeScore of 2 is low but does not block wiring. Future pipeline runs with
  `npm run sprites:run -- --brief briefs/weapons/baseball-bat.yaml` can improve the art.

- **Vertical orientation (default weapon type)**: Bat held upright with thick barrel
  at top and knob at base — matches the weapon type default and existing v1 geometry
  (anchor derived at 31, 60).

- **Art-only PR**: No game code changes needed. The equipment concept → sprite
  resolution is already fully wired via the existing `weaponId` mapping.

## What's Next / Blockers

- Future: run `npm run sprites:run -- --brief briefs/weapons/baseball-bat.yaml` with
  Azure credentials to generate a fresh candidate with better judgeScore. Approve and
  check in as `baseball-bat-v4` (or higher) when a quality candidate is obtained.
- Issue #1303 (aggregate Floor 2 equipment tracking) should mark `weapon.baseball-bat`
  as `brief-ready` after this PR merges.

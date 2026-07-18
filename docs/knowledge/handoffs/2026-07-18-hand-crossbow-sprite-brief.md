# Handoff: hand-crossbow Sprite Brief

## Date

2026-07-18

## Persona

Graphics Designer

## Systems touched

sprite-pipeline

## Apples

1🍎 exact — pure art task: brief authoring only. No engine code, equipment defs,
or weapon defs changed.

## What Was Done

Authored the production-ready source brief `briefs/weapons/hand-crossbow.yaml`
for the Floor 2 hand crossbow equipment icon (issue #1310).

- **Runtime key**: `equipment/weapon/hand-crossbow`
- **Stable ID**: `weapon.hand-crossbow`
- **Production wave**: `floor2-equipment-weapon-bow`

Brief details:

- `type: weapon` — inherits 64×64, kenney-roguelike palette, 4×4 sheet, VLM
  judge enabled from `data/sprite-types/weapon.json`
- `orientation: diagonal` — stock at bottom-left, prod extending up-and-right
  at ~45°; matches compact-disk brief pattern for held/thrown weapons
- `anchor: {x:22, y:50}` — shifted to the pistol-grip area (lower-left
  quadrant), consistent with diagonal-held weapons
- `diagonalToleranceDeg: 6` — slightly wider than default (5) to account for
  the natural variation in a stocky crossbow prod geometry
- 2 authored variation seeds + `minVariations: 8` for generation diversity
- Palette: muted dark brown (stock), iron-grey/slate-black (prod, hardware),
  single highlight; no glow, no enchantment

Verified: `npm run verify:fast` — 1260 tests pass, all guards green.

## Key Decisions Made

1. **Brief only, no gameplay code**: The issue is an asset request; the
   `hand-crossbow` weapon game entity (equip def, weapon def, items entry) is
   tracked separately and will come in a future implementation PR.

2. **Diagonal orientation** (not vertical): A hand crossbow held in profile
   reads best at 45°. Vertical would make it look like a straight staff or
   wand; horizontal doesn't fit the weapon sprite sensor family.

3. **anchor {x:22,y:50}**: The pistol grip sits in the lower-left quadrant for
   a ~45° diagonal weapon. The default weapon anchor {x:32,y:56} targets a
   bottom-center grip, which would sit outside the silhouette for a diagonal.
   Modeled on compact-disk's {x:32,y:40} with slight y adjustment.

4. **`diagonalToleranceDeg: 6`**: The crossbow prod (bow arms) is wider and
   stubbier than a sword, so the orientation sensor needs a touch more
   tolerance; compact-disk uses 8°, iron-sword uses 3°. 6° is a reasonable
   midpoint for a compact ranged weapon.

## What's Next / Blockers

- **Sprite generation**: The `asset-request.yml` CI workflow was already
  triggered by the issue's `asset-request` label. Once the Azure sprite run
  completes, the sprite will be approved via `npm run sprites:gallery` and
  checked in via `npm run sprites:checkin`.

- **Gameplay code**: `hand-crossbow` as an equippable item with a `WeaponDef`
  and `EquipmentItemDef` is a separate Floor 2 content task.

## Retrospective

### Lessons Learned

- For diagonal weapon briefs, always override both `orientation` and `anchor`;
  the default vertical anchor at {x:32,y:56} will be off-center for a
  diagonal weapon and may fail the anchor sensor.
- The `diagonalToleranceDeg` value should scale with how "wide" the weapon
  silhouette is relative to its diagonal axis — wider/stubbier weapons need
  more tolerance.

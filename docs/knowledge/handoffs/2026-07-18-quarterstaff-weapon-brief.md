# Handoff: Quarterstaff Weapon Brief

## Date

2026-07-18

## Persona

Graphics Designer

## Systems touched

sprite-pipeline

## Apples

1🍎 exact — pure art task: brief authoring only. No code changes.

## What Was Done

Authored the production-ready brief `briefs/weapons/quarterstaff.yaml` for
the Floor 2 equipment quarterstaff weapon icon (issue #1307).

**Brief summary:**

- Type: `weapon` (polearm family, production wave `floor2-equipment-weapon-polearm`)
- Runtime key: `equipment/weapon/quarterstaff`
- Stable ID: `weapon.quarterstaff`
- Orientation: vertical (inherited from `data/sprite-types/weapon.json`)
- Anchor: `{x: 32, y: 44}` — overridden from the default `{x: 32, y: 56}` so the
  grip-wrap lands near the anchor and the ferrule-tip reads clearly above it
  (a quarterstaff is longer and thinner than a top-heavy mace, so the grip
  centre sits higher in the canvas)
- Size: 64×64, 4×4 sheet (inherited from weapon.json defaults)
- Palette: `kenney-roguelike` (inherited)
- `variations`: 2 author seeds (spalted-wood grain, rope-wrapped grip)
- `minVariations: 8` — asks the text provider to top up to 8 variations

**Validation:**

- `loadBrief` validation: ✅ passes (correct name/type/anchor/sensors)
- `verify:fast`: ✅ 1260/1260 tests pass, no regressions

## Key Decisions Made

- **Brief file only (no PNG)**: Azure sprite generation credentials are not
  available in this sandbox session. The CI asset-request pipeline picks up the
  brief and generates the sprite when Azure credentials are present. The brief
  is the source of truth that drives generation.

- **Anchor override `{x:32, y:44}`**: A quarterstaff's grip is lower-middle on
  the shaft, not at the very base. The default weapon anchor `{x:32, y:56}` is
  designed for pommel-grip weapons (sword, mace). For a polearm, placing the
  anchor at y=44 (roughly 69% down the 64px canvas) centres the grip section
  near the anchor while keeping the ferrule-tip visible above.

- **Vertical orientation**: Inherited from weapon.json. A quarterstaff is
  naturally held upright, so vertical is the correct orientation (not diagonal
  like the iron-sword).

- **Not stacking on `nalfeo-floor-2-equipment-placeholders`**: The floor2
  equipment art system lives on that branch (not yet merged). This PR delivers
  the brief spec; when the floor2 placeholders branch lands, this brief will
  drive replacement of the `equipment/weapon/quarterstaff-placeholder.png`
  placeholder via the normal checkin workflow.

## What's Next / Blockers

- Azure credentials required to generate the actual PNG from this brief.
  Trigger via `npm run sprites:run -- --brief quarterstaff` or let the
  `asset-request.yml` CI workflow handle it.
- Once a variant is approved, run `npm run sprites:checkin` to update the
  manifest and catalog.
- Batch with other polearm-wave assets via `npm run sprites:asset-pr` into the
  single art-only PR described in issue #1303.

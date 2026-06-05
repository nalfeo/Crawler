# Session Handoff: Item-System Sprite Anchor Audit

## Date

2026-06-05

## What Was Done

Audited every item-like schema in the runtime for a 2D sprite anchor (the pixel
that pins a sprite to a holder's hand for equip / render / rotation, matching
the `anchor: { x, y }` field on sprite briefs in the in-flight pipeline PR).

**Findings — anchors were absent everywhere:**

| Schema | Location | Sprite ref? | Anchor? |
| --- | --- | --- | --- |
| `ItemDef` | `src/shared/items.ts` | `icon: string` (placeholder) | no |
| `EquipmentItemDef` | `src/shared/equipment-types.ts` | none | no |
| `WeaponDef` | `src/shared/weaponDefs.ts` | none (mechanics-only) | no |
| `SpriteDef` | `src/engine/sprites/registry.ts` | this *is* the sprite | no |
| `Sprite` ECS | `src/core/components.ts` | `textureId/width/height` | no |

**No runtime consumer of an item anchor exists yet:**

- `PhaserBridge.resolveTexture()` only resolves entity-type sprites
  (player, enemy, gem, projectile). Nothing renders an equipped weapon on the
  player.
- `InventoryUI.ts` renders inventory icons as the first 2 characters of the
  item name (text placeholder).
- `equipment-lab` paper doll is pure DOM, no sprites.

**Minimal schema change (per rubber-duck critique to avoid dead fields on 100+
items):**

- Added `src/shared/sprite-anchor.ts`:
  - `interface SpriteAnchor { x: number; y: number }`
  - `DEFAULT_HANDHELD_SPRITE_ANCHOR = { x: 8, y: 14 }` — bottom-center of a
    16×16 frame, matching the weapon-brief default in `scripts/sprites/`.
  - `resolveHandheldAnchor(anchor?)` helper.
  - `isValidAnchor(anchor, frameW, frameH)` — integer bounds check against the
    actual sheet frame dimensions (not hardcoded 16).
- Added optional `anchor?: SpriteAnchor` to **engine `SpriteDef` only**.
  Sprite anchors are properties of the pixels, so the sprite registry is the
  natural owner. No declared anchors yet (existing entries unchanged); the
  field exists so new entries can co-locate the anchor with the (sheet, frame)
  it describes.
- Exported the type from `src/shared/index.ts` and `src/engine/sprites/index.ts`.
- Tests: `tests/unit/sprite-anchor.test.ts` covers default, resolver, and
  bounds-check edges (negative, fractional, NaN, infinity, non-square frames).
  Added an assertion to `tests/unit/sprite-registry.test.ts` that any DECLARED
  anchor lies inside its sprite sheet's frame.

**Deliberately NOT done:**

- Did **not** add `anchor` to `ItemDef`, `EquipmentItemDef`, or `WeaponDef`.
  None of those carry a sprite reference today; bolting an anchor onto them
  would create three dead duplicate fields with unclear precedence rules, and
  would force backfill across 100+ catalog items and lab fixtures for no
  runtime benefit.
- Did **not** touch `scripts/sprites/**`, `data/sprite-types/**`, `briefs/**`,
  or sprite-pipeline tests (out of scope per task brief — PR #28 territory).
- Did **not** modify `Sprite` ECS component. Adding two more `Float32Array`s
  per entity for a feature nobody reads yet is wasteful; wire it in when the
  equipped-item renderer is built.

## What's Next

When the equipped-item / weapon-on-hand renderer is built (the system the user
implicitly expects to exist), the wiring is:

1. Give items / equipment a way to reference an engine `SpriteDef` — either
   `EquipmentItemDef.spriteId?: string` resolving via `getSprite(id)`, or fold
   `ItemDef.icon` into a typed sprite-id once the placeholder is replaced.
2. The renderer reads
   `resolveHandheldAnchor(sprite.anchor)` to pick a per-sprite anchor with the
   handheld default as fallback.
3. Populate `anchor` on individual `SPRITES` entries as artwork lands — the
   sprite-pipeline PR will produce briefs with anchors that map 1:1 onto these.

If `Sprite` ECS data needs per-entity anchor overrides (e.g. dynamically
generated weapons), add `anchorX`/`anchorY: Float32Array` to the store at that
point — not before.

## Blockers

None. Schema is in place and tested. Awaiting the renderer that consumes it.

## Branch State

- Branch: `nalfeo/item-anchor-audit`
- All tests passing: yes (414 passed, 51 files)
- Typecheck: clean
- Lint: clean (`--max-warnings 0`)
- PR created: yes

## Test Results

```
npm run typecheck   ✓ exit 0
npm run lint        ✓ exit 0
npm test            ✓ 414 passed (414), 51 files
```

New file: `tests/unit/sprite-anchor.test.ts` (12 tests).
Extended: `tests/unit/sprite-registry.test.ts` with a frame-bounds assertion
over any declared anchor.

## Key Decisions Made

- **Anchor lives on `SpriteDef`, not on item/equipment defs.** Single source of
  truth tied to the actual pixels. Items will reach the anchor by referencing a
  sprite-id once such a link is added. Rationale: avoids precedence conflicts
  between item-side and sprite-side anchors and prevents three parallel
  optional fields all defaulting to the same value.
- **Optional + named default helper, not required + backfill.** Required would
  force 100+ items to carry the same `{ 8, 14 }` literal as dead noise.
- **Default named `DEFAULT_HANDHELD_SPRITE_ANCHOR`, not `DEFAULT_SPRITE_ANCHOR`.**
  The bottom-center anchor only makes sense for hand-held 16×16 sprites;
  helmets, rings, projectiles, tiles, and VFX have different natural anchors.
  The name documents the scope.
- **Validator takes frame dimensions as parameters.** The sprite-pipeline brief
  schema already supports arbitrary `size.width/height`; hardcoding 16×16 in
  the validator would falsely reject anchors on future larger sprites.

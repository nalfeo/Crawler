# Handoff: Real baseball-bat swing sprite (PhaserBridge)

**Date:** 2026-07-03
**Apple estimate:** 🍎🍎
**Actual:** 🍎🍎 (single-file rendering fix + small anchor/scale generalization; no cross-system churn)

## Problem

In-game melee swing for the baseball-bat weapon rendered the Kenney tiny-dungeon
placeholder (`weapon.bat`, sheet frame 117) instead of the approved generated art
(`baseball-bat-v1`, approved 2026-06-30). The inventory icon already showed the
real art via `src/shared/items.ts` (`icon: 'baseball-bat-v1'`) resolved through
the `GENERATED_SPRITE_REGISTRY_KEY` scene-registry entry, but the swing renderer
in `src/engine/PhaserBridge.ts` hardcoded:

```ts
const weaponSpriteKey = swingSprite === MeleeSpriteId.BAT ? 'weapon.bat' : 'weapon.sword';
```

## Change

`src/engine/PhaserBridge.ts` melee-swing branch (around line 534):

1. When `swingSprite === MeleeSpriteId.BAT`, resolve the approved generated
   sprite via the same path `InventoryUI.ts` uses:
   - `getGeneratedSpriteRegistry(scene)` (helper already lived in this file).
   - `pickGeneratedVariant(registry, 'baseball-bat-v1', eid | 0)` — swing
     entity ids are stable across the ~200 ms lifetime of one swing, so a
     given swing keeps its variant.
   - Guard with `scene.textures?.exists?.(entry.textureKey)`; fall back to the
     Kenney `weapon.bat` if the manifest isn't loaded / no variant approved.
2. Sword branch (`MeleeSpriteId.SWORD` / default) unchanged — no approved
   generated `sword-v1` art exists in `public/assets/generated/manifest.json`
   or `src/shared/data/sprite-catalog.json`. When one lands, add its briefId
   to the `generatedBriefId` conditional and the same fallback logic covers
   both weapons.
3. Anchor + scale generalized: the previous code hardcoded a 16×16 frame with
   `holdY = DEFAULT_HANDHELD_SPRITE_ANCHOR.y = 14`. Generated art can ship at
   32×32 or 64×64 with its own hold anchor. Now:
   - `frameWidth` / `frameHeight` come from the resolved texture's source
     image (fallback: 16).
   - `holdX` / `holdY` come from the generated entry's `anchor` (fallback:
     `DEFAULT_HANDHELD_SPRITE_ANCHOR`).
   - `origin = (holdX / frameWidth, holdY / frameHeight)`; the `bladeLen /
holdY` scale formula and `MIN_WEAPON_SPRITE_SCALE = 1.8` floor are
     preserved.
4. Cached `visuals.get(eid)` image now reconciles to the preferred texture key
   mid-swing when the generated manifest becomes available (mirrors the enemy
   reconcile pattern later in the same file — "upgrade off placeholder art").

## Non-changes / follow-ups

- **`getMeleeSpriteId` in `src/game/weaponSystem.ts` (discrepancy):** the
  2026-06-21 handoff (`2026-06-21-weapons-sprites.md`) claims hammer reuses
  `MeleeSpriteId.BAT`. The current switch only maps `sword` → `SWORD` and
  `baseball-bat` → `BAT`; every other weapon (including `hammer`) falls
  through to `0`. **Not fixed here** — orthogonal to the sprite-key resolution
  in PhaserBridge and would change the actual runtime sprite hint stored on
  every hammer swing. A separate PR should decide: (a) hammer maps to `BAT`
  and shares baseball-bat art until hammer-v1 approves, (b) add a new
  `MeleeSpriteId.HAMMER` + hammer brief, or (c) update the stale handoff.

## Files touched

- `src/engine/PhaserBridge.ts` (+92, −27)
- `docs/knowledge/handoffs/2026-07-03-baseball-bat-swing-sprite.md` (new)
- `docs/knowledge/review-ledgers/2026-07-03-baseball-bat-swing-sprite.review-ledger.json` (new)

No changes to `weaponSystem.ts`, `constants.ts`, `InventoryUI.ts`,
`items.ts`, or the generated-manifest loader/schema.

## Validation

- `npm run verify:fast` — ✅ passes (typecheck + lint + changed unit tests).
- `npx vitest run tests/integration/generated-manifest-engine.test.ts
tests/unit/phaser-bridge.test.ts` — ✅ 31 tests pass.
- Existing PhaserBridge unit tests still pass; the melee-swing branch has no
  dedicated unit test today, and the fallback path (no registry, no textures
  loaded) produces the same `weapon.bat` behavior as before (bit-for-bit
  scale/origin, since the parameterized code reduces to the hardcoded 16/14
  values when `generatedEntry === null`).

## Observe before done

**Not yet observed in a running artifact** — this is a cloud session with no
local Phaser runtime. Runtime evidence must be captured in a follow-up
worktree session or via CI's e2e job:

- `npm run lab -- ?lab=weapon-lab` — swing the baseball bat, confirm sprite is
  the generated `baseball-bat-v1-var-N.png` at the player's hand rather than
  the 16×16 Kenney frame. Capture a before/after screenshot.
- `npm run dev` — same, in the real game with a Floor 1 baseball-bat loadout.

A follow-up shepherd session should attach the screenshot and update this
handoff / PR body before merge.

## Review harness

🍎🍎 tier → separate-model plan review recorded in
`docs/knowledge/review-ledgers/2026-07-03-baseball-bat-swing-sprite.review-ledger.json`.

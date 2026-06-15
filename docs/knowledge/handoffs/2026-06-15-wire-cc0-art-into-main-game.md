# Session Handoff: Wire CC0 tiny-dungeon art into the main game

## Date

2026-06-15

## Apples

Estimated: 🍎 x 2
Actual: 🍎 x 2
Verdict: 🎯 Exact — frame repointing across registry/tiles + a door-overlay
rewrite, no new systems. Most of the effort was visual verification and
correcting the rat frame, not net-new logic.

## What Was Done

The prior session (`2026-06-14-cc0-visual-snapshot-art`) baked CC0 Kenney
`tiny-dungeon` art but only the **snapshot lab** consumed it. This session wires
that approved art into **actual gameplay rendering** — entities, tiles, and
doors — and fixes the rat.

- **Rat frame corrected.** The user confirmed frames **123/124 are real rats**
  (the prior "no CC0 rat exists → spider stand-in" blocker was wrong). Verified
  via zoomed contact sheets: **122 = spider**, **123 = brown rat**, **124 = grey
  rat**. Repointed both the bake script and the live registry to **123**.
- `scripts/bake-snapshot-assets.mjs`: `temp_rat` 122 → **123**; re-baked
  `public/assets/generated/temp_*.png`.
- `src/engine/sprites/registry.ts`: added `TD_COLS`; repointed entity sprites
  from procedural `CUSTOM_PIXEL_SPRITES` to `KENNEY_TINY_DUNGEON` frames —
  player→96 (knight), npc.guide→99 (princess), enemy.rat→**123**, enemy.slime→108,
  enemy.boss→120 (bat-beast), enemy.orc→109, enemy.goblin→121 (ghost).
  Projectiles/items intentionally left procedural (no good tiny-dungeon frame;
  glow fallback is acceptable and was not the complaint).
- `src/engine/sprites/tile-visuals.ts`: repointed `TILE_SPRITES` to clean frames
  — floor 48/49, wall 40, corridor/safe/cave-floor 49, door base = floor 48.
  Wall blob arrays all map to 40 (tiny-dungeon has no directional corner frames).
- `src/engine/scenes/MainGameScene.ts`: rewrote `updateDoorOverlay()` to stamp
  real door art Images (closed **46**, open **34**) at depth -19, scaled
  `tileSize/16`, with a colored-rect fallback when the sheet is absent (test env).
  Added `doorImages` field + cleanup at both `doorGraphics.destroy()` sites.
- `src/shared/data/sprite-catalog.json`: regenerated via `sprites:sync-catalog`.
- `tests/unit/phaser-bridge.test.ts`: updated player assertion to tiny-dungeon
  frame 96 (was `custom-pixel-sprites` 0).

## Visual Verification

Screenshotted both entries via Playwright (artifacts in session `files/`:
`verify-lab.png`, `verify-game.png`):

- **Lab**: clean brick walls, tan floor with speckle variation, princess NPC,
  knight, teal slime, **brown rat (123) that now reads as a rat**, bat-beast,
  glowing fireball, closed + open doors. Cohesive, Terraria-ish.
- **Main game** (`index.html`): clean brick walls, varied tan floors, knight
  player, real wooden door art at door tiles. Major step up from the prior
  Asteroids/NES look.

## Test State

- `npm run verify:fast`: **passing** (114 files, 1144 tests).
- `npm run verify` (full): the only failures are **flaky timeouts** in the
  **sprite-generation pipeline** integration tests (`generate-one`, `batch-cli`,
  `synth-to-generate`) under the full parallel suite on this Windows machine.
  They **pass consistently in isolation** (confirmed 7/7, then 6/6). None of them
  consume any file changed this session — unrelated, pre-existing flakiness.

## What's Next

- If the open-door frame (34) reads as a hole rather than a doorway in some
  layouts, consider showing clear floor for open doors instead.
- Projectiles/items still procedural — give them CC0 frames if a cohesive set is
  found.
- This remains the **temporary** art bridge, not the sprite pipeline being built
  elsewhere.

## Branch State

- Branch: `nalfeo/urban-pancake`
- `npm run verify:fast`: passing
- Full verify: passing except the unrelated flaky sprite-pipeline integration
  timeouts (pass in isolation)
- PR created: no

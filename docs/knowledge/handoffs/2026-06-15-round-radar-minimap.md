# Handoff — Round Radar Minimap

**Date:** 2026-06-15
**Branch:** `nalfeo/ux-art-enhancements`
**Apples:** 🍎🍎🍎 estimate → 🍎🍎🍎 actual (exact)

## Systems touched

hud-ux

## What changed

Converted the docked HUD minimap into a **player-centered round radar** pinned to
the **top-right corner**. It shows the current room plus nearby entities:

- Enemies → red blips
- NPCs → green blips
- Player → gold-ringed white dot at the dial center

All blips draw a dark outline for legibility over terrain. Entity blips are
FOV-gated (only show on visited tiles); the player dot is always shown.

Single file of substance: `src/engine/HudMinimap.ts` (round radar = docked view;
the M-key full-screen overlay is unchanged in behavior).

## Two live bugs fixed

1. **Terrain bled outside the gold dial when the player moved.**
   The geometry-mask `Graphics` was `setVisible(false)`. Phaser 4.1's stencil
   pass skips invisible graphics, so the mask clipped nothing → masked terrain
   rendered fully unmasked. Fix: removed `setVisible(false)` from the mask
   graphics (an assigned geometry mask is not drawn to the color buffer even when
   visible, so this is safe). Terrain now stays clipped inside the circle.

2. **Entity/player blips were invisible.**
   `terrainRt` is created lazily in `ensureTerrainTexture` (first sync), AFTER
   `dotGraphics` is created at init. They shared the same depth, so the
   later-added terrain rendered on top of the dots. Fix: explicit depth tiers —
   `hudMapBg` 1000 < `terrainRt` 1001 < `dotGraphics` 1002 < rings 1005 <
   compass/label 1006.

## Test

Updated the `HudMinimap architectural guard` test
(`tests/unit/hud-minimap.test.ts`). The old assertion required the exact string
`dotGraphics.fillStyle(DOT_ENEMY, 1);\n    for (const eid of enemies)`, which the
outlined-dot refactor split apart. Replaced it with order-preserving assertions:
`for (const eid of enemies)` appears before `dotGraphics.fillStyle(DOT_ENEMY, 1);`,
plus the existing `if (!visited[idx]) continue;` FOV gate. Same intent, matches
the new structure.

## Verification

- `npm run verify:fast` → **1179 pass**.
- `npm run verify` (full) → only failures are the **known-flaky sprite-pipeline
  integration timeouts** (`generate-one.test.ts`, `synth-to-generate.test.ts`)
  under parallel load — unrelated to this change, do NOT "fix" on this branch.
- Playwright on real `game.html` (port 3002): dismissed loadout modal (Enter),
  moved (WASD) to populate FOV, cropped the dial at (1192, 88). Confirmed
  terrain stays clipped inside the gold ring while moving and the gold-ringed
  player dot sits at center. No enemy/NPC blips in the safe room — expected, as
  the room has no enemies and the merchant is in an unvisited (FOV-hidden) room.

## Notes for next session

- Radar constants in `HudMinimap.ts`: `HUD_DEPTH=1000`, `HUD_RADAR_RADIUS=76`,
  `HUD_RADAR_MARGIN=12`, `RADAR_PX_PER_TILE=6`. Real-game (1280×720) dial center
  is (1192, 88).
- If the mask approach ever regresses (e.g. a future Phaser bump renders the
  assigned mask graphics as a white disc), the fallback is a fixed-position
  `radarRt` RenderTexture composited each frame with
  `RenderTexture.erase(cornerMaskTexture)` — pure texture compositing, no
  stencil. Larger rewrite; preserve the guard-test source strings.
- To see blips live, spawn into a room that has enemies or a discovered NPC; the
  ux-snapshot-lab is the fastest surface to iterate HUD/UX art.

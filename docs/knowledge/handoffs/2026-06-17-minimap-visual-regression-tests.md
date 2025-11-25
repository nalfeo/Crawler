# Handoff — Minimap visual regression tests

**Date:** 2026-06-17  
**Branch:** `copilot/add-visual-regression-tests-minimap`  
**Apples:** 🍎🍎 estimate → 🍎🍎 actual (exact)

## Systems touched

hud-ux

## What changed

Added two new `describe` blocks to `tests/unit/hud-minimap.test.ts` covering the
visual rendering contracts for both minimap modes:

### `HudMinimap small/docked radar visual regression` (18 tests)

Guards the round dial in the top-right corner:

- Dial geometry: `HUD_RADAR_DIAMETER = 152`, radius derived from diameter, inner
  clip `RADAR_CLIP_RADIUS = HUD_RADAR_RADIUS - 4`.
- Top-right positioning formula: `radarCx = width - HUD_RADAR_MARGIN - HUD_RADAR_RADIUS`.
- Chrome: gold beveled ring (`PIXEL_UI.gold`), compass "N" at dial top, "MAP (M)"
  label beneath.
- RenderTexture: allocated at `HUD_RADAR_DIAMETER × HUD_RADAR_DIAMETER`, NEAREST
  filter, depth `HUD_DEPTH + 1` (chrome rings at `HUD_DEPTH + 5`).
- Terrain zoom: `RADAR_PX_PER_TILE = 6` constant asserted in `drawRadar`.
- Analytic circular clip: `inDial` helper using `Math.hypot`.
- Frame lifecycle: `radarRt.clear()` → draw terrain → `radarScratch` blips →
  `radarRt.draw(radarScratch)` → `radarRt.render()`.
- Entity blips on `radarScratch`: enemies red, NPCs green, player gold-ring/white.
- FOV gate: `!visited[ty * floorMap.width + tx] continue` in `drawRadar`.
- Overlay opens → `radarRt.setVisible(false)`.

### `HudMinimap enlarged overlay visual regression` (16 tests)

Guards the full-screen map panel opened with M:

- `overlayDimmer` visible/hidden toggling.
- "Dungeon Map" title and pan/zoom hint text contents.
- Close button `✕` + `closeButtonBg` wired to `closeOverlay`.
- Room markers: SAFE teal `0x2dd4bf`, BOSS_STAIR amber `0xf59e0b`, SPAWN blue
  `0x60a5fa`.
- Staircase marker gated on `staircaseSpawned && staircaseDiscovered`.
- Entity blips on `dotGraphics`: enemy, NPC, player gold-ring/white; FOV gate.
- `applyViewTransform`: `snappedZoom = Math.round(zoom * 2) / 2` for crisp pixels;
  `terrainRt` and `dotGraphics` share the same `originX/originY`.
- `setOverlayVisible`: overlay open → `terrainRt/dotGraphics` show, `radarRt`
  hides; overlay closed → reverse.
- Docked chrome hides when overlay opens: `hudMapBg`, `hudRingGold`, `hudCompass`,
  `hudMapLabel` all `setVisible(!visible)`.

## Verification

`npm run verify:fast` → **42 tests pass** (was 1222 across full suite; the fast
run exercised only the unit project which showed "no test files" in an earlier run
due to a caching artefact — re-running resolved it; the single-file run confirmed
42/42).

## Notes for next session

- All new tests are source-string assertions (same pattern as the existing
  `HudMinimap architectural guard`); they don't require Phaser to be instantiated.
- If `HudMinimap.ts` is ever split into separate files for radar vs overlay, the
  `beforeAll` source path will need updating.
- The `RoomRole.SPAWN` marker (`DOT_SPAWN_ROOM = 0x60a5fa`) appears as
  `? DOT_SPAWN_ROOM` in the ternary chain — the test uses that form, not
  `: DOT_SPAWN_ROOM`.

import { beforeAll, describe, expect, it } from 'vitest';
import {
  clampMinimapViewState,
  panMinimapByScreenDelta,
  zoomMinimapAtPoint,
  type MinimapViewState,
} from '../../src/engine/minimap-view-state.js';

function mapPointAtScreen(
  view: MinimapViewState,
  screenX: number,
  screenY: number,
): { x: number; y: number } {
  return {
    x: view.centerX + (screenX - view.viewportWidth / 2) / view.zoom,
    y: view.centerY + (screenY - view.viewportHeight / 2) / view.zoom,
  };
}

describe('hud minimap view math', () => {
  it('centers the map when zoomed out so the map is smaller than the viewport', () => {
    const view = clampMinimapViewState({
      centerX: 10,
      centerY: 20,
      zoom: 0.5,
      mapWidth: 100,
      mapHeight: 80,
      viewportWidth: 400,
      viewportHeight: 300,
    });

    expect(view.centerX).toBe(50);
    expect(view.centerY).toBe(40);
  });

  it('clamps panning at map bounds', () => {
    const view = clampMinimapViewState({
      centerX: 40,
      centerY: 30,
      zoom: 2,
      mapWidth: 120,
      mapHeight: 90,
      viewportWidth: 200,
      viewportHeight: 120,
    });

    const pannedFar = panMinimapByScreenDelta(view, 1000, -1000);
    expect(pannedFar.centerX).toBe(50);
    expect(pannedFar.centerY).toBe(60);
  });

  it('keeps the focus point stable while zooming at a cursor position', () => {
    const view: MinimapViewState = {
      centerX: 50,
      centerY: 50,
      zoom: 2,
      mapWidth: 200,
      mapHeight: 200,
      viewportWidth: 300,
      viewportHeight: 220,
    };
    const focusX = 240;
    const focusY = 80;
    const before = mapPointAtScreen(view, focusX, focusY);
    const next = zoomMinimapAtPoint(view, 3, focusX, focusY, {
      minZoom: 0.5,
      maxZoom: 10,
    });
    const after = mapPointAtScreen(next, focusX, focusY);

    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('clamps zoom requests to provided min and max limits', () => {
    const base: MinimapViewState = {
      centerX: 50,
      centerY: 50,
      zoom: 2,
      mapWidth: 100,
      mapHeight: 100,
      viewportWidth: 200,
      viewportHeight: 200,
    };

    const tooSmall = zoomMinimapAtPoint(base, 0.01, 100, 100, { minZoom: 0.75, maxZoom: 8 });
    const tooLarge = zoomMinimapAtPoint(base, 999, 100, 100, { minZoom: 0.75, maxZoom: 8 });

    expect(tooSmall.zoom).toBe(0.75);
    expect(tooLarge.zoom).toBe(8);
  });
});

describe('HudMinimap architectural guard', () => {
  it('flushes baked terrain updates and keeps special-room markers wired', async () => {
    const { readFileSync } = await import('fs');
    const source = (readFileSync as (path: string, encoding: string) => string)(
      'src/engine/HudMinimap.ts',
      'utf-8',
    );

    expect(source).toContain('terrainRt.render();');
    expect(source).toContain('terrainRt.texture.setFilter(Phaser.Textures.FilterMode.NEAREST);');
    expect(source).toContain('RoomRole.SAFE');
    expect(source).toContain('RoomRole.BOSS_STAIR');
    expect(source).toContain('objective?.staircaseSpawned && objective.staircaseDiscovered');
    expect(source).toContain('const closeButtonBg = scene.add');
    expect(source).toContain('const OVERLAY_CLOSE_BUTTON_SIZE = 52;');
    expect(source).toContain('const OVERLAY_CLOSE_BUTTON_MAX_SIZE = 72;');
    expect(source).toContain('const closeButtonSize = Math.min(');
    expect(source).toContain('Math.round(OVERLAY_CLOSE_BUTTON_SIZE * getUiScale(scene))');
    expect(source).toContain('closeButtonBg.setSize(closeButtonSize, closeButtonSize);');
    expect(source.indexOf('const color =')).toBeLessThan(
      source.indexOf('roomHasDiscoveredTile(room, floorMap, visited)'),
    );
    expect(source).toContain('for (const eid of enemies)');
    expect(source).toContain('resolveEnemyDotStyle(world, eid, DOT_ENEMY_RADIUS);');
    expect(source.indexOf('for (const eid of enemies)')).toBeLessThan(
      source.indexOf('dotGraphics.fillStyle(style.color, 1);'),
    );
    expect(source).toContain('if (!visited[idx]) continue;');
  });
});

describe('HudMinimap small/docked radar architectural guards', () => {
  // Reads the HudMinimap source and asserts critical rendering properties for
  // the round dial that appears in the top-right corner of the HUD.
  // NOTE: These are source-code string assertions, not pixel-level visual tests.
  // Pixel-level visual regression lives in tests/e2e/minimap-overlay.test.ts.
  let source: string;
  beforeAll(async () => {
    const { readFileSync } = await import('fs');
    source = (readFileSync as (path: string, encoding: string) => string)(
      'src/engine/HudMinimap.ts',
      'utf-8',
    );
  });

  it('uses the correct dial diameter and derives radius from it', () => {
    expect(source).toContain('const HUD_RADAR_DIAMETER = NAV_RADAR_DIAMETER;');
    expect(source).toContain('const HUD_RADAR_RADIUS = HUD_RADAR_DIAMETER / 2;');
  });

  it('inner clip radius leaves a thin chrome rim (HUD_RADAR_RADIUS - 4)', () => {
    expect(source).toContain('const RADAR_CLIP_RADIUS = HUD_RADAR_RADIUS - 4;');
  });

  it('pins the dial to the top-right corner using margin and the responsive radius', () => {
    expect(source).toContain('const navLayout = resolveNavigationHudLayout(getUiScale(scene), 1);');
    expect(source).toContain(
      'const scaledCx = navLayout.radarBounds.x + navLayout.radarBounds.width / 2;',
    );
  });

  it('scales the docked dial up on small screens (capped, mirrors the HUD)', () => {
    expect(source).toContain('const radarScale = navLayout.radarScale;');
    expect(source).toContain('const scaledRadius = HUD_RADAR_RADIUS * radarScale;');
    expect(source).toContain('hudMapBg.setPosition(scaledCx, scaledCy).setScale(radarScale);');
    expect(source).toContain(
      'radarRt.setPosition(scaledCx - scaledRadius, scaledCy - scaledRadius).setScale(radarScale);',
    );
  });

  it('has a gold beveled ring around the dial', () => {
    expect(source).toContain('const hudRingGold = scene.add');
    expect(source).toContain('.setStrokeStyle(6, PIXEL_UI.gold, 0.95)');
  });

  it('renders a compass "N" label at the top of the dial', () => {
    expect(source).toContain(".text(0, 0, 'N', {");
    // N marker is positioned near the top of the dial circumference
    expect(source).toContain(
      'hudCompass.setPosition(scaledCx, scaledCy - scaledRadius + 9 * radarScale).setScale(radarScale);',
    );
  });

  it('renders the "MAP (M)" hint label beneath the dial', () => {
    expect(source).toContain(".text(0, 0, 'MAP (M)', {");
    expect(source).toContain('.setPosition(scaledCx, scaledCy + scaledRadius + 4 * radarScale)');
  });

  it('allocates the radar RenderTexture at the exact dial pixel dimensions', () => {
    expect(source).toContain('.renderTexture(0, 0, HUD_RADAR_DIAMETER, HUD_RADAR_DIAMETER)');
  });

  it('applies NEAREST filter to the radar RenderTexture for pixel-sharp terrain', () => {
    expect(source).toContain('radarRt.texture.setFilter(Phaser.Textures.FilterMode.NEAREST);');
  });

  it('places the radar RenderTexture at depth HUD_DEPTH + 1 so chrome rings sit on top', () => {
    // radarRt is created then depth is set; rings are assigned HUD_DEPTH + 5
    const radarRtIdx = source.indexOf('const radarRt = scene.add');
    const depthIdx = source.indexOf('.setDepth(HUD_DEPTH + 1)', radarRtIdx);
    expect(depthIdx).toBeGreaterThan(radarRtIdx);
    expect(source).toContain('.setDepth(HUD_DEPTH + 5)');
  });

  it('tiles terrain at RADAR_PX_PER_TILE pixels per dungeon tile (zoom = 6)', () => {
    expect(source).toContain('const RADAR_PX_PER_TILE = 6;');
    expect(source).toContain('const scale = RADAR_PX_PER_TILE;');
  });

  it('applies an analytic circular clip using inDial so terrain stays inside the dial', () => {
    expect(source).toContain(
      'const inDial = (x: number, y: number): boolean => Math.hypot(x - cx, y - cy) <= reach;',
    );
  });

  it('clears the radar RenderTexture before each draw to prevent ghosting', () => {
    expect(source).toContain('radarRt.clear();');
  });

  it('flushes the radar RenderTexture after compositing blips', () => {
    // render() must come after draw(radarScratch)
    const drawIdx = source.indexOf('radarRt.draw(radarScratch);');
    const renderIdx = source.indexOf('radarRt.render();', drawIdx);
    expect(drawIdx).toBeGreaterThan(0);
    expect(renderIdx).toBeGreaterThan(drawIdx);
  });

  it('composites blips from radarScratch into the radar RenderTexture', () => {
    expect(source).toContain('radarRt.draw(radarScratch);');
  });

  it('draws enemy blips on radarScratch tinted by resolveEnemyDotStyle', () => {
    expect(source).toContain('radarScratch.fillStyle(style.color, 1);');
    const styleIdx = source.indexOf(
      'const style = resolveEnemyDotStyle(world, eid, DOT_ENEMY_RADIUS);',
    );
    const enemyCircleIdx = source.indexOf('radarScratch.fillCircle(ex, ey, style.radius * scale)');
    expect(enemyCircleIdx).toBeGreaterThan(styleIdx);
  });

  it('draws NPC blips on radarScratch in green', () => {
    expect(source).toContain('radarScratch.fillStyle(DOT_NPC, 1);');
    const npcStyleIdx = source.indexOf('radarScratch.fillStyle(DOT_NPC, 1);');
    const npcCircleIdx = source.indexOf('radarScratch.fillCircle(nx, ny, DOT_NPC_RADIUS * scale)');
    expect(npcCircleIdx).toBeGreaterThan(npcStyleIdx);
  });

  it('draws the player dot with a gold ring and white centre', () => {
    // Gold outer ring
    const ringIdx = source.indexOf('radarScratch.fillStyle(DOT_PLAYER_RING, 1);');
    expect(ringIdx).toBeGreaterThan(0);
    // White inner centre drawn after the ring
    const centreIdx = source.indexOf('radarScratch.fillStyle(DOT_PLAYER, 1);', ringIdx);
    expect(centreIdx).toBeGreaterThan(ringIdx);
  });

  it('gates entity blips in drawRadar behind the FOV visited-tile check', () => {
    // All three entity loops use the same visited gate pattern in drawRadar
    expect(source).toContain('if (!visited[ty * floorMap.width + tx]) continue;');
  });

  it('clears radarScratch before drawing blips to prevent cross-frame accumulation', () => {
    expect(source).toContain('radarScratch.clear();');
    const clearIdx = source.indexOf('radarScratch.clear();');
    // clear must come before the enemy loop in drawRadar; the same helper is
    // reused in drawDots (before clear) so search from clearIdx forward.
    const enemyLoopIdx = source.indexOf(
      'const style = resolveEnemyDotStyle(world, eid, DOT_ENEMY_RADIUS);',
      clearIdx,
    );
    expect(enemyLoopIdx).toBeGreaterThan(clearIdx);
  });

  it('hides the radar RenderTexture when the overlay is open', () => {
    expect(source).toContain('radarRt.setVisible(false);');
  });
});

describe('HudMinimap enlarged overlay architectural guards', () => {
  // Reads the HudMinimap source and asserts critical rendering properties for
  // the full-screen map overlay toggled with M or by clicking the radar dial.
  // NOTE: These are source-code string assertions, not pixel-level visual tests.
  // Pixel-level visual regression lives in tests/e2e/minimap-overlay.test.ts.
  let source: string;
  beforeAll(async () => {
    const { readFileSync } = await import('fs');
    source = (readFileSync as (path: string, encoding: string) => string)(
      'src/engine/HudMinimap.ts',
      'utf-8',
    );
  });

  it('dims the screen behind the overlay with a dark rectangle', () => {
    expect(source).toContain('const overlayDimmer = scene.add');
    expect(source).toContain('overlayDimmer.setVisible(visible);');
  });

  it('shows a beveled panel background for the map area', () => {
    expect(source).toContain('const panelBg = scene.add');
  });

  it('displays "Dungeon Map" as the overlay title', () => {
    expect(source).toContain(".text(0, 0, 'DUNGEON MAP', {");
  });

  it('shows pan/zoom and keyboard hints at the bottom of the overlay', () => {
    expect(source).toContain(
      ".text(0, 0, 'DRAG/PINCH: PAN & ZOOM  |  WHEEL / +/-: ZOOM  |  M: CLOSE', {",
    );
  });

  it('has a close button marked with ✕', () => {
    expect(source).toContain(".text(0, 0, '✕', {");
    expect(source).toContain('const closeButtonBg = scene.add');
    expect(source).toContain("closeButtonBg.on('pointerdown', closeOverlay);");
  });

  it('draws discovered safe-room markers in teal (DOT_SAFE_ROOM = 0x2dd4bf)', () => {
    expect(source).toContain('const DOT_SAFE_ROOM = 0x2dd4bf;');
    expect(source).toContain('return DOT_SAFE_ROOM;');
  });

  it('draws boss-stair room markers in amber (DOT_BOSS_ROOM = 0xf59e0b)', () => {
    expect(source).toContain('const DOT_BOSS_ROOM = 0xf59e0b;');
    expect(source).toContain('return DOT_BOSS_ROOM;');
  });

  it('draws spawn room markers in blue (DOT_SPAWN_ROOM = 0x60a5fa)', () => {
    expect(source).toContain('const DOT_SPAWN_ROOM = 0x60a5fa;');
    expect(source).toContain('return DOT_SPAWN_ROOM;');
  });

  it('draws staircase marker only when spawned and discovered by the player', () => {
    expect(source).toContain('objective?.staircaseSpawned && objective.staircaseDiscovered');
    const gateIdx = source.indexOf('objective?.staircaseSpawned && objective.staircaseDiscovered');
    const stairsIdx = source.indexOf('DOT_STAIRS', gateIdx);
    expect(stairsIdx).toBeGreaterThan(gateIdx);
  });

  it('draws enemy blips on dotGraphics using resolveEnemyDotStyle for the overlay', () => {
    expect(source).toContain('dotGraphics.fillStyle(style.color, 1);');
  });

  it('draws NPC blips on dotGraphics in green for the overlay', () => {
    expect(source).toContain('dotGraphics.fillStyle(DOT_NPC, 1);');
  });

  it('draws the player marker with a gold ring on dotGraphics for the overlay', () => {
    expect(source).toContain('dotGraphics.fillStyle(DOT_PLAYER_RING, 1);');
    const ringIdx = source.indexOf('dotGraphics.fillStyle(DOT_PLAYER_RING, 1);');
    const centreIdx = source.indexOf('dotGraphics.fillStyle(DOT_PLAYER, 1);', ringIdx);
    expect(centreIdx).toBeGreaterThan(ringIdx);
  });

  it('snaps zoom to half-pixel grid in applyViewTransform for crisp terrain', () => {
    expect(source).toContain(
      'const snappedZoom = Math.max(0.25, Math.round(viewState.zoom * 2) / 2);',
    );
  });

  it('aligns terrain and dot-graphics to the same origin in applyViewTransform', () => {
    // Both objects share originX/originY so blips never drift from terrain
    const terrainSetPos = source.indexOf(
      'terrainRt.setPosition(Math.round(originX), Math.round(originY)).setScale(snappedZoom);',
    );
    const dotsSetPos = source.indexOf(
      'dotGraphics.setPosition(Math.round(originX), Math.round(originY)).setScale(snappedZoom);',
    );
    expect(terrainSetPos).toBeGreaterThan(0);
    expect(dotsSetPos).toBeGreaterThan(0);
  });

  it('shows terrain and dot-graphics when overlay opens, hides them when it closes', () => {
    // setOverlayVisible(true) branch
    expect(source).toContain('terrainRt?.setVisible(Boolean(lastFloorMap));');
    expect(source).toContain('dotGraphics.setVisible(Boolean(lastFloorMap));');
    // setOverlayVisible(false) branch
    expect(source).toContain('terrainRt?.setVisible(false);');
  });

  it('gates overlay entity blips behind the FOV visited-tile check', () => {
    expect(source).toContain('if (!visited[idx]) continue;');
  });

  it('hides the docked radar chrome when overlay is open', () => {
    // hudMapBg, rings, compass and label flip visibility via setOverlayVisible
    expect(source).toContain('hudMapBg.setVisible(!visible);');
    expect(source).toContain('hudRingGold.setVisible(!visible);');
    expect(source).toContain('hudCompass.setVisible(!visible);');
    expect(source).toContain('hudMapLabel.setVisible(!visible);');
  });
});

describe('HudMinimap mobile layout regression', () => {
  // Guards the responsive behaviour of updateLayout so the minimap remains
  // usable on narrow/short mobile viewports and reflows on orientation change.
  let source: string;
  beforeAll(async () => {
    const { readFileSync } = await import('fs');
    source = (readFileSync as (path: string, encoding: string) => string)(
      'src/engine/HudMinimap.ts',
      'utf-8',
    );
  });

  it('subscribes to the Phaser scale resize event so layout reflows on orientation change', () => {
    expect(source).toContain("scene.scale.on('resize', updateLayout);");
  });

  it('unsubscribes from the resize event on destroy to prevent memory leaks', () => {
    expect(source).toContain("scene.scale.off('resize', updateLayout);");
  });

  it('anchors HUD layout to the design space (GAME.WIDTH/HEIGHT), not the HiDPI backing store', () => {
    // Regression guard for the #353 supersampling bug: after #353 the canvas
    // backing store is `design × S` and a zoom-S UI camera rescales HUD objects.
    // Laying the radar/overlay out from scene.scale.gameSize double-scales them
    // off-screen on HiDPI displays. Layout must use the design constants instead.
    expect(source).toContain('return { width: GAME.WIDTH, height: GAME.HEIGHT };');
    expect(source).not.toContain('scene.scale.gameSize');
  });

  it('converts pointer input to design space so HiDPI hit-testing and panning stay aligned', () => {
    // Phaser pointer coords are in backing-store space; the overlay viewport is
    // laid out in design space. Pointer input must be divided by the render scale
    // (identity at S=1) before hit-testing or computing pan deltas.
    expect(source).toContain('function toDesignSpace(');
    expect(source).toContain('const s = getRenderScale(scene);');
    expect(source).toContain('return { x: x / s, y: y / s };');
  });

  it('clamps the overlay panel width to a minimum of 640px for narrow screens', () => {
    // Math.max(640, width * 0.86) ensures the panel never collapses on phones
    expect(source).toContain('Math.max(640, width * 0.86)');
  });

  it('clamps the overlay panel height to a minimum of 420px for short screens', () => {
    expect(source).toContain('Math.max(420, height * 0.84)');
  });

  it('clamps the map viewport width to at least 120px so the content area stays usable', () => {
    expect(source).toContain('Math.max(120, panelW - 32)');
  });

  it('clamps the map viewport height to at least 80px so the content area stays usable', () => {
    expect(source).toContain('Math.max(80, panelH - 76)');
  });

  it('keeps the dial pinned to the top-right at any screen width via the margin constant', () => {
    // The formula uses `width` from getGameSize(), so it always tracks the real edge.
    expect(source).toContain(
      'const scaledCx = navLayout.radarBounds.x + navLayout.radarBounds.width / 2;',
    );
  });

  it('re-clamps the view state after a resize so the map stays within new viewport bounds', () => {
    // After a resize, viewState must be re-clamped with the new viewport dimensions.
    const resizeIdx = source.indexOf("scene.scale.on('resize', updateLayout);");
    // updateLayout updates viewport dimensions and calls clampMinimapViewState
    expect(source).toContain('viewportWidth: viewport.width,');
    expect(source).toContain('viewportHeight: viewport.height,');
    // The resize handler is registered
    expect(resizeIdx).toBeGreaterThan(0);
  });
});

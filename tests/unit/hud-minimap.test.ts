import { describe, expect, it } from 'vitest';
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
    expect(source).toContain('RoomRole.SAFE');
    expect(source).toContain('RoomRole.BOSS_STAIR');
    expect(source).toContain('objective?.staircaseSpawned && objective.staircaseDiscovered');
    expect(source.indexOf('const color =')).toBeLessThan(
      source.indexOf('roomHasDiscoveredTile(room, floorMap, visited)'),
    );
    expect(source).toContain(
      'dotGraphics.fillStyle(DOT_ENEMY, 1);\n    for (const eid of enemies)',
    );
  });
});

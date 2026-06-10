/**
 * terrain-renderer — bake a FloorMap's visual terrain into a Phaser RenderTexture.
 *
 * Why RenderTexture?
 * -----------------
 * A 675×675 map is ~455 k tiles. Individual Phaser Image/Sprite objects at that
 * scale would crater the scene graph and GC. A RenderTexture is a single GPU
 * surface: we stamp each tile frame once at floor-load time and the scene renders
 * the whole map as one draw call every frame.
 *
 * How it works:
 *   1. Allocate a RenderTexture sized to the floor in pixels.
 *   2. Iterate every tile. If a TileVisualDef exists, stamp that spritesheet
 *      frame at the tile's pixel position via rt.drawFrame().
 *   3. Tiles with no mapped sprite fall back to a solid-color fill drawn onto a
 *      temporary Graphics object that is then stamped and destroyed.
 *   4. Return the finished RenderTexture for the scene to position and manage.
 *
 * The returned RenderTexture is positioned at (0, 0) in world-space by default.
 * Callers should .setDepth(-20) to render beneath game entities.
 *
 * Fallback: if the Kenney sheet for a tile is not loaded (e.g. test environments
 * or load errors), the color-only path is used for that tile automatically.
 *
 * No runtime imports from src/core/, src/game/, or src/labs/. Type-only imports
 * from core are acceptable in the engine layer and are erased at build time.
 */

import Phaser from 'phaser';
import type { FloorMap } from '../core/map/FloorMap.js';
import { TerrainType } from '../shared/map-types.js';
import { TERRAIN_FALLBACK_COLORS } from '../shared/terrain-colors.js';
import { getTileVisual, resolveFrame } from './sprites/tile-visuals.js';
import { getSheet } from './sprites/index.js';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('engine:terrain-renderer');

/**
 * Result of `buildTerrainLayer`.
 * `spriteCount` / `colorCount` are diagnostic values for the lab / logging.
 */
export interface TerrainLayerResult {
  rt: Phaser.GameObjects.RenderTexture;
  /** Number of tiles rendered via spritesheet frame. */
  spriteCount: number;
  /** Number of tiles rendered via solid-color fallback. */
  colorCount: number;
}

/**
 * Bake all terrain tiles from `floorMap` into a single RenderTexture.
 *
 * The RenderTexture is added to the scene at (0, 0). Callers are responsible
 * for setting depth and scroll factor.
 *
 * @param scene  Active Phaser scene — used to create the RenderTexture.
 * @param floorMap  The floor to render.
 */
export function buildTerrainLayer(scene: Phaser.Scene, floorMap: FloorMap): TerrainLayerResult {
  const { width, height, config } = floorMap;
  const tileSize = config.tileSizePx;

  const rt = scene.add.renderTexture(0, 0, width * tileSize, height * tileSize);

  // Collect fallback tiles so we can batch all color fills into one Graphics
  // draw call before stamping, avoiding per-tile Graphics object creation.
  type ColorTile = { x: number; y: number; color: number };
  const colorTiles: ColorTile[] = [];

  let spriteCount = 0;
  let colorCount = 0;

  for (let ty = 0; ty < height; ty++) {
    for (let tx = 0; tx < width; tx++) {
      const idx = ty * width + tx;
      const terrain: TerrainType = floorMap.terrain[idx] ?? TerrainType.VOID;
      const visual = getTileVisual(terrain);

      if (visual && scene.textures.exists(visual.sheetKey)) {
        const sheet = getSheet(visual.sheetKey);
        const frameSize = sheet?.frameWidth ?? tileSize;
        const scale = tileSize / frameSize;
        const frame = resolveFrame(visual, floorMap.terrain, width, height, tx, ty, terrain);
        rt.stamp(visual.sheetKey, frame, tx * tileSize, ty * tileSize, {
          originX: 0,
          originY: 0,
          scaleX: scale,
          scaleY: scale,
        });
        spriteCount++;
      } else {
        const color = TERRAIN_FALLBACK_COLORS[terrain] ?? 0x05060f;
        colorTiles.push({ x: tx * tileSize, y: ty * tileSize, color });
        colorCount++;
      }
    }
  }

  // Batch all color-fallback tiles into a single Graphics → stamp pass.
  if (colorTiles.length > 0) {
    const g = scene.add.graphics();

    // Group by color to minimize fillStyle() calls.
    const byColor = new Map<number, ColorTile[]>();
    for (const tile of colorTiles) {
      let group = byColor.get(tile.color);
      if (!group) {
        group = [];
        byColor.set(tile.color, group);
      }
      group.push(tile);
    }

    for (const [color, tiles] of byColor) {
      g.fillStyle(color, 1);
      for (const tile of tiles) {
        g.fillRect(tile.x, tile.y, tileSize, tileSize);
      }
    }

    rt.draw(g, 0, 0);
    g.destroy();
  }

  logger.debug('Terrain layer built', {
    width,
    height,
    spriteCount,
    colorCount,
    spriteCoverage:
      width * height > 0 ? `${Math.round((spriteCount / (width * height)) * 100)}%` : '0%',
  });

  return { rt, spriteCount, colorCount };
}

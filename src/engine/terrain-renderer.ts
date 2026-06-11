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

  // setOrigin(0,0) so that internal pixel (tx*tileSize, ty*tileSize) maps
  // directly to world position (tx*tileSize, ty*tileSize). The default Image
  // origin of (0.5, 0.5) would shift the entire texture left/up by half its
  // dimensions, misaligning every tile with the rest of the scene.
  const rt = scene.add.renderTexture(0, 0, width * tileSize, height * tileSize).setOrigin(0, 0);

  let spriteCount = 0;
  let colorCount = 0;

  for (let ty = 0; ty < height; ty++) {
    for (let tx = 0; tx < width; tx++) {
      const idx = ty * width + tx;
      const terrain: TerrainType = floorMap.terrain[idx] ?? TerrainType.VOID;
      const visual = getTileVisual(terrain);
      const shouldForceColorFallback =
        terrain === TerrainType.STONE_FLOOR ||
        terrain === TerrainType.CORRIDOR ||
        terrain === TerrainType.STONE_WALL ||
        terrain === TerrainType.BOSS_STAIR_FLOOR ||
        terrain === TerrainType.SAFE_ROOM_FLOOR ||
        terrain === TerrainType.CAVE_WALL ||
        terrain === TerrainType.WOOD_WALL;

      if (!shouldForceColorFallback && visual && scene.textures.exists(visual.sheetKey)) {
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
        // rt.fill() queues a fill command into Phaser 4's DynamicTexture buffer.
        // Commands are NOT visible until rt.render() is called below.
        const color = TERRAIN_FALLBACK_COLORS[terrain] ?? 0x05060f;
        rt.fill(color, 1, tx * tileSize, ty * tileSize, tileSize, tileSize);
        colorCount++;
      }
    }
  }

  // Phaser 4: flush all buffered fill/stamp commands to the GPU framebuffer.
  // Without this call nothing drawn above will appear on screen.
  rt.render();

  logger.info('[terrain-renderer] layer built', {
    mapTiles: `${width}x${height}`,
    rtPos: `(${rt.x}, ${rt.y})`,
    rtOrigin: `(${rt.originX}, ${rt.originY})`,
    rtSize: `${rt.width}x${rt.height}`,
    rtDepth: rt.depth,
    spriteCount,
    colorCount,
    totalTiles: width * height,
    spriteCoverage:
      width * height > 0 ? `${Math.round((spriteCount / (width * height)) * 100)}%` : '0%',
  });

  return { rt, spriteCount, colorCount };
}

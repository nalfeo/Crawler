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
 *   2. Iterate every tile. Resolve its TileVisualDef, then stamp by precedence:
 *      a. GENERATED single-texture tile — if the def has a `textureKey` whose
 *         texture is loaded with a usable width, stamp the whole PNG scaled to
 *         the tile size (approved generated art beats the Kenney placeholder).
 *      b. KENNEY spritesheet frame — else, if the sheet is loaded, stamp that
 *         frame at the tile's pixel position via rt.stamp().
 *      c. SOLID COLOR — else fall back to a color fill.
 *   3. Return the finished RenderTexture for the scene to position and manage.
 *
 * The returned RenderTexture is positioned at (0, 0) in world-space by default.
 * Callers should .setDepth(-20) to render beneath game entities.
 *
 * Fallbacks are ordered generated → sheet → color. If a generated tile texture
 * is missing or has an invalid width (e.g. test environments or load errors),
 * that tile falls through to the Kenney sheet frame; if the Kenney sheet is
 * also absent, the color-only path is used for that tile automatically.
 *
 * No runtime imports from src/core/, src/game/, or src/labs/. Type-only imports
 * from core are acceptable in the engine layer and are erased at build time.
 */

import Phaser from 'phaser';
import type { FloorMap } from '../core/map/FloorMap.js';
import { TerrainType } from '../shared/map-types.js';
import { PIXELS_PER_FOOT } from '../shared/units.js';
import { TERRAIN_FALLBACK_COLORS } from '../shared/terrain-colors.js';
import { getTileVisual, resolveFrame } from './sprites/tile-visuals.js';
import { getSheet } from './sprites/index.js';
import { createLogger } from '../shared/logger.js';
import { buildPassageRenderPlan } from './terrain/passage-smoothing.js';

const logger = createLogger('engine:terrain-renderer');

/**
 * Result of `buildTerrainLayer`.
 * `generatedCount` / `spriteCount` / `colorCount` are diagnostic values for the
 * lab / logging and the observe-before-done probe (they sum to the tile total).
 */
export interface TerrainLayerResult {
  rt: Phaser.GameObjects.RenderTexture;
  /** Number of tiles rendered via a GENERATED single-texture stamp. */
  generatedCount: number;
  /** Number of tiles rendered via a Kenney spritesheet frame. */
  spriteCount: number;
  /** Number of tiles rendered via solid-color fallback. */
  colorCount: number;
}

export interface TerrainLayerOptions {
  readonly smoothPassages?: boolean;
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
export function buildTerrainLayer(
  scene: Phaser.Scene,
  floorMap: FloorMap,
  options: TerrainLayerOptions = {},
): TerrainLayerResult {
  const { width, height, config } = floorMap;
  // Bake terrain at native pixel resolution: feet → px via PIXELS_PER_FOOT.
  // The renderer keeps the world in pixel-space, so this layer is placed at
  // pixel coordinates (0,0) and spans width*tileSize × height*tileSize px.
  const tileSize = config.tileSizeFt * PIXELS_PER_FOOT;

  // setOrigin(0,0) so that internal pixel (tx*tileSize, ty*tileSize) maps
  // directly to world position (tx*tileSize, ty*tileSize). The default Image
  // origin of (0.5, 0.5) would shift the entire texture left/up by half its
  // dimensions, misaligning every tile with the rest of the scene.
  const rt = scene.add.renderTexture(0, 0, width * tileSize, height * tileSize).setOrigin(0, 0);

  let generatedCount = 0;
  let spriteCount = 0;
  let colorCount = 0;

  // Per-textureKey scale memo. Generated tiles are single PNGs whose pixel width
  // is constant per key, so resolve the tileSize/width scale ONCE per key rather
  // than calling getSourceImage() for each of the ~455k tiles. A cached `null`
  // marks a key whose texture is missing or has an unusable width, so that tile
  // deterministically falls through to the Kenney sheet path below.
  const generatedScaleCache = new Map<string, number | null>();
  const resolveGeneratedScale = (textureKey: string): number | null => {
    const cached = generatedScaleCache.get(textureKey);
    if (cached !== undefined) return cached;
    let scale: number | null = null;
    if (scene.textures.exists(textureKey)) {
      const source = scene.textures.get(textureKey).getSourceImage() as { width?: number };
      const srcWidth = typeof source?.width === 'number' ? source.width : 0;
      if (srcWidth > 0) scale = tileSize / srcWidth;
    }
    generatedScaleCache.set(textureKey, scale);
    return scale;
  };

  for (let ty = 0; ty < height; ty++) {
    for (let tx = 0; tx < width; tx++) {
      const idx = ty * width + tx;
      const terrain: TerrainType = floorMap.terrain[idx] ?? TerrainType.VOID;
      const visual = getTileVisual(terrain);

      const generatedScale = visual?.textureKey ? resolveGeneratedScale(visual.textureKey) : null;

      if (visual?.textureKey && generatedScale !== null) {
        // Generated single-texture tile: stamp the whole PNG scaled to tileSize.
        // Passing `undefined` for the frame uses the texture's default `__BASE`
        // frame — a single generated PNG has no sub-frames to select.
        rt.stamp(visual.textureKey, undefined, tx * tileSize, ty * tileSize, {
          originX: 0,
          originY: 0,
          scaleX: generatedScale,
          scaleY: generatedScale,
        });
        generatedCount++;
      } else if (visual && scene.textures.exists(visual.sheetKey)) {
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

  if (options.smoothPassages === true && typeof scene.add.graphics === 'function') {
    const plan = buildPassageRenderPlan(floorMap);
    if (plan.groups.length > 0) {
      const overlay = scene.add.graphics().setVisible(false);
      for (const group of plan.groups) {
        overlay.fillStyle(group.color, group.alpha);
        for (const circle of group.circles) {
          overlay.fillCircle(
            circle.xTiles * tileSize,
            circle.yTiles * tileSize,
            circle.radiusTiles * tileSize,
          );
        }
      }
      rt.draw(overlay);
      overlay.destroy();
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
    generatedCount,
    spriteCount,
    colorCount,
    totalTiles: width * height,
    // Coverage = any non-color tile (generated OR Kenney sheet). A tile only
    // counts as uncovered when it fell all the way through to the color fill.
    spriteCoverage:
      width * height > 0
        ? `${Math.round(((generatedCount + spriteCount) / (width * height)) * 100)}%`
        : '0%',
  });

  return { rt, generatedCount, spriteCount, colorCount };
}

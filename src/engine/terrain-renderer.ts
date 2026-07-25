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
 *      a. PACK surface (wall atlas / floor pool / corridor pool) — if a
 *         `terrainPackId` is supplied, the tile type is eligible, AND
 *         `scene.textures.exists(textureKey)` is true, stamp from the pack.
 *         For WALL tiles a floor-pool underdraw is stamped first so that
 *         transparent regions of the blob47 silhouette (open-edge quadrants
 *         are inset by WALL_INSET_PX of alpha) expose ground rather than the
 *         empty RenderTexture (which reads as pure black).
 *         Missing pack textures fall through to the next step so a cold boot
 *         or an asset load error never leaves a blank tile.
 *      b. GENERATED single-texture tile — if the def has a `textureKey` whose
 *         texture is loaded with a usable width, stamp the whole PNG scaled to
 *         the tile size (approved generated art beats the Kenney placeholder).
 *      c. KENNEY spritesheet frame — else, if the sheet is loaded, stamp that
 *         frame at the tile's pixel position via rt.stamp().
 *      d. SOLID COLOR — else fall back to a color fill.
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
import { computeRawMask8, normalizeBlob47Mask } from '../shared/terrain-pack-mask.js';
import { getTerrainPack } from '../shared/terrain-pack-registry.js';
import { pickPoolVariant } from '../shared/terrain-pack-variants.js';
import {
  TERRAIN_PACK_CELL_PX,
  type TerrainPackId,
  type WallAutotileDef,
} from '../shared/terrain-pack-types.js';

const logger = createLogger('engine:terrain-renderer');

/**
 * TerrainType groups eligible for a terrain-pack surface, keyed by which
 * pack contract (`wallAutotile` / `floorPool` / `corridorPool`) applies.
 *
 * A pack is attached per-FLOOR (via `terrainPackId` on the floor manifest),
 * not per-biome, so this table generalizes across any biome that reuses the
 * "stone-like wall" / "stone-like floor" / "corridor" terrain vocabulary —
 * today only Floor 2's `cave_system` biome (CAVE_WALL/CAVE_FLOOR) opts in,
 * but STONE_WALL/STONE_FLOOR are included so a future dungeon-biome floor
 * could adopt a pack with no renderer changes. CORRIDOR is its own group
 * because pack manifests deliberately separate `floorPool` from
 * `corridorPool` (reviewed-design refinement #2 — no coarse single mode).
 */
const PACK_WALL_TERRAIN_TYPES: ReadonlySet<TerrainType> = new Set([
  TerrainType.STONE_WALL,
  TerrainType.CAVE_WALL,
]);
const PACK_FLOOR_TERRAIN_TYPES: ReadonlySet<TerrainType> = new Set([
  TerrainType.STONE_FLOOR,
  TerrainType.CAVE_FLOOR,
]);
const PACK_CORRIDOR_TERRAIN_TYPES: ReadonlySet<TerrainType> = new Set([TerrainType.CORRIDOR]);

/** Build a `maskId -> frameIndex` lookup once per bake from the pack's explicit table. */
function buildMaskFrameLookup(wallAutotile: WallAutotileDef): ReadonlyMap<number, number> {
  return new Map(wallAutotile.masks.map((entry) => [entry.maskId, entry.frameIndex]));
}

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
  /**
   * Number of WALL tiles rendered via a terrain-pack blob47 atlas frame
   * (bypassing the legacy `generatedCount`/`spriteCount` paths entirely).
   * Zero whenever `options.terrainPackId` is omitted or the frame lookup
   * misses. This is the runtime assertion seam proving Floor 2 uses atlas
   * frame stamping instead of the old generated-single-image bypass.
   */
  packWallCount: number;
  /** Number of FLOOR tiles rendered via a terrain-pack `floorPool` variant. */
  packFloorCount: number;
  /** Number of CORRIDOR tiles rendered via a terrain-pack `corridorPool` variant. */
  packCorridorCount: number;
}

/** Optional per-bake terrain-pack selection. */
export interface TerrainLayerOptions {
  /** Registry-backed terrain pack id — omit to keep the exact legacy path. */
  terrainPackId?: TerrainPackId;
}

/**
 * Bake all terrain tiles from `floorMap` into a single RenderTexture.
 *
 * The RenderTexture is added to the scene at (0, 0). Callers are responsible
 * for setting depth and scroll factor.
 *
 * @param scene  Active Phaser scene — used to create the RenderTexture.
 * @param floorMap  The floor to render.
 * @param options.terrainPackId  Registry-backed terrain pack id (e.g. Floor
 *   2's `industrial-cave`). When present, WALL/FLOOR/CORRIDOR tiles (per
 *   `PACK_*_TERRAIN_TYPES`) stamp the pack's atlas/pool textures instead of
 *   the legacy `TILE_SPRITES` path. When omitted (e.g. Floor 1), rendering is
 *   byte-for-byte identical to the pre-terrain-pack behavior.
 */
export function buildTerrainLayer(
  scene: Phaser.Scene,
  floorMap: FloorMap,
  options?: TerrainLayerOptions,
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
  let packWallCount = 0;
  let packFloorCount = 0;
  let packCorridorCount = 0;

  // Terrain-pack lookups, resolved once per bake (not per tile). `pack` is
  // null when the floor omits `terrainPackId` (e.g. Floor 1) — every pack
  // branch below is gated on it, so the legacy path is untouched in that case.
  const pack = options?.terrainPackId ? getTerrainPack(options.terrainPackId) : null;
  const maskFrameLookup = pack ? buildMaskFrameLookup(pack.wallAutotile) : null;
  const floorSeed = config.seed;
  const packWallScale = pack ? tileSize / pack.wallAutotile.cellPx : 1;
  const packPoolScale = tileSize / TERRAIN_PACK_CELL_PX;

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

      // Terrain-pack precedence: WALL/FLOOR/CORRIDOR tiles eligible for this
      // pack's surfaces are stamped from the pack's atlas/pool textures FIRST,
      // bypassing the legacy generated/sheet/color path entirely for that
      // tile. Each pack branch stamps only when the texture is actually loaded
      // (`textures.exists` guard); if the texture is missing the tile falls
      // through to the generated/Kenney/color chain below so a cold boot or
      // a missing asset never leaves a blank tile.
      if (pack && maskFrameLookup && PACK_WALL_TERRAIN_TYPES.has(terrain)) {
        const rawMask = computeRawMask8(tx, ty, width, height, (nx, ny) =>
          PACK_WALL_TERRAIN_TYPES.has(floorMap.terrain[ny * width + nx] as TerrainType),
        );
        const canonicalMask = normalizeBlob47Mask(rawMask);
        const frameIndex = maskFrameLookup.get(canonicalMask);
        if (frameIndex !== undefined && scene.textures.exists(pack.wallAutotile.textureKey)) {
          // Stamp the floor pool variant underneath the wall frame first, so that
          // transparent regions of the blob47 silhouette (open-edge quadrants are
          // inset by WALL_INSET_PX of alpha) expose ground rather than the empty
          // RenderTexture (which reads as black). The underdraw is NOT counted in
          // packFloorCount — it is not a floor tile from the player's perspective
          // and must not pollute floor-diversity metrics.
          const underVariant = pickPoolVariant(pack.floorPool, floorSeed, tx, ty);
          if (underVariant && scene.textures.exists(underVariant.textureKey)) {
            rt.stamp(underVariant.textureKey, undefined, tx * tileSize, ty * tileSize, {
              originX: 0,
              originY: 0,
              scaleX: packPoolScale,
              scaleY: packPoolScale,
            });
          }
          rt.stamp(pack.wallAutotile.textureKey, frameIndex, tx * tileSize, ty * tileSize, {
            originX: 0,
            originY: 0,
            scaleX: packWallScale,
            scaleY: packWallScale,
          });
          packWallCount++;
          continue;
        }
        // Texture missing or mask not found — fall through to legacy chain.
      }
      if (pack && PACK_FLOOR_TERRAIN_TYPES.has(terrain)) {
        const variant = pickPoolVariant(pack.floorPool, floorSeed, tx, ty);
        if (variant && scene.textures.exists(variant.textureKey)) {
          rt.stamp(variant.textureKey, undefined, tx * tileSize, ty * tileSize, {
            originX: 0,
            originY: 0,
            scaleX: packPoolScale,
            scaleY: packPoolScale,
          });
          packFloorCount++;
          continue;
        }
        // Texture missing — fall through to legacy chain.
      }
      if (pack && PACK_CORRIDOR_TERRAIN_TYPES.has(terrain)) {
        const variant = pickPoolVariant(pack.corridorPool, floorSeed, tx, ty);
        if (variant && scene.textures.exists(variant.textureKey)) {
          rt.stamp(variant.textureKey, undefined, tx * tileSize, ty * tileSize, {
            originX: 0,
            originY: 0,
            scaleX: packPoolScale,
            scaleY: packPoolScale,
          });
          packCorridorCount++;
          continue;
        }
        // Texture missing — fall through to legacy chain.
      }

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
    packWallCount,
    packFloorCount,
    packCorridorCount,
    terrainPackId: options?.terrainPackId ?? null,
    totalTiles: width * height,
    // Coverage = any non-color tile (generated, Kenney sheet, OR pack atlas/pool).
    // A tile only counts as uncovered when it fell all the way through to the
    // color fill.
    spriteCoverage:
      width * height > 0
        ? `${Math.round(
            ((generatedCount + spriteCount + packWallCount + packFloorCount + packCorridorCount) /
              (width * height)) *
              100,
          )}%`
        : '0%',
  });

  return {
    rt,
    generatedCount,
    spriteCount,
    colorCount,
    packWallCount,
    packFloorCount,
    packCorridorCount,
  };
}

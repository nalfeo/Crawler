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
import { RoomRole, TerrainType } from '../shared/map-types.js';
import { PIXELS_PER_FOOT } from '../shared/units.js';
import { TERRAIN_FALLBACK_COLORS } from '../shared/terrain-colors.js';
import { getTileVisual, resolveFrame } from './sprites/tile-visuals.js';
import { getSheet } from './sprites/index.js';
import { createLogger } from '../shared/logger.js';
import {
  computeRawMask8Grid,
  FULLY_OPAQUE_BLOB47_MASK,
  normalizeBlob47Mask,
} from '../shared/terrain-pack-mask.js';
import { getTerrainPack } from '../shared/terrain-pack-registry.js';
import {
  buildGroundDecalStampConfig,
  buildLineworkPropStampConfig,
  buildLineworkStampConfig,
  buildPoolStampConfig,
  groundDecalHalfExtentPx,
  pickLineworkPropFrame,
  pickPoolCombo,
  pickWallAccentSelection,
  pickGroundDecal,
  shouldPlaceLineworkProp,
} from '../shared/terrain-pack-variants.js';
import {
  lineworkRunAxis,
  planLinework,
  LINEWORK_EMPTY,
  LINEWORK_GROUND,
  LINEWORK_BURIED,
  LINEWORK_WALL_ENTRY,
  type LineworkHub,
} from '../shared/terrain-linework.js';
import {
  TERRAIN_PACK_CELL_PX,
  type PoolVariantDef,
  type TerrainPackDef,
  type TerrainPackId,
  type TransformId,
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

/**
 * Terrain a wall's blob47 neighbour mask must read as WALL even though the tile
 * itself is not stamped from the wall atlas.
 *
 * The governing rule (maintainer-specified): a wall only insets
 * (`WALL_INSET_PX`) on a side whose neighbour is WALKABLE. A wall should NOT
 * inset toward a neighbour that is itself solid/impassable — the wall body
 * should reach flush to that boundary — because insetting there exposes a
 * sliver of the wall pack's floor-pool underdraw (stamped so the inset region
 * of a *walkable*-side quadrant isn't blank) sitting inside what is meant to
 * read as solid rock/wood/wall. So this set is exactly "wall types ∪
 * non-walkable-but-not-wall types the mask should still treat as solid",
 * rather than a literal walkability predicate — there is no existing
 * TerrainType → walkability helper in the codebase (`TileFlags`/`TilePresets`
 * are a separate per-tile PHYSICS array from `TerrainType`, which is purely
 * visual), so each addition here is a deliberate, documented choice:
 *
 *   - `STONE_WALL` / `CAVE_WALL` (via `PACK_WALL_TERRAIN_TYPES`): other pack
 *     walls — a wall run must not inset against its own kind.
 *   - `DOOR`: a hole punched through a wall line, whose own art (`doorSet`) is
 *     a full-bleed tile whose jambs run edge to edge. If the mask treated a
 *     door as floor, the walls flanking it would inset away from the shared
 *     boundary and leave a visible strip of floor between wall and jamb — the
 *     wall would stop short of the doorway instead of running into it.
 *   - `VOID`: solid rock fill outside authored rooms (`TerrainType.VOID = 0`).
 *     A wall bordering VOID previously insetted away from it, exposing a
 *     sliver of ROOM FLOOR sitting inside the rock — light bleeding out past
 *     the wall into what should be solid stone. This is the primary defect
 *     this set exists to fix.
 *   - `WOOD_WALL`: a different wall material, but still a wall — same
 *     "must not inset against another wall" logic as `STONE_WALL`/`CAVE_WALL`.
 *   - `TREE`: non-walkable, so the rule "only inset toward walkable space"
 *     puts it here. No generator writes `TREE` today, so this is currently
 *     inert; it is included so the set matches the stated rule rather than
 *     only the terrain that happens to exist right now.
 *
 * Deliberately EXCLUDED, even though non-walkable:
 *   - `WATER` / `LAVA`: these are visible-through hazards, not rock — you can
 *     see across/into them, so a wall should still inset toward them exactly
 *     as it does toward ordinary floor (you can see the lava through the
 *     inset gap; that is correct, not a bug).
 *   - `RUBBLE`: no generator currently places this terrain type and its
 *     walkability semantics are not defined/authored anywhere, so it is left
 *     out rather than guessed at; revisit if/when `RUBBLE` is actually used.
 *
 * This is a NEIGHBOUR-ONLY rule: none of these additions make the neighbour
 * tile itself get stamped from the wall atlas — only the silhouette a wall
 * selects for ITS OWN mask changes based on what borders it.
 *
 * See also `computeRawMask8`'s `outOfBoundsMatches` parameter
 * (`src/shared/terrain-pack-mask.ts`) — the map-edge counterpart of this rule.
 * A wall on the map boundary has no real neighbour past the edge; that missing
 * neighbour must also read as solid (not floor), or the wall full-bleeds into
 * nothing at the border the same way it used to bleed into VOID.
 */
export const PACK_WALL_MASK_NEIGHBOR_TERRAIN_TYPES: ReadonlySet<TerrainType> = new Set([
  ...PACK_WALL_TERRAIN_TYPES,
  TerrainType.DOOR,
  TerrainType.VOID,
  TerrainType.WOOD_WALL,
  TerrainType.TREE,
]);

/**
 * Minimum share of a ground decal's rotated bounding box that must be ground for
 * the decal to be placed. Decals are clipped by the wall pass rather than
 * excluded by it, so this is not a containment rule — it only stops a large set
 * from firing into a one-tile corridor, where nearly all of it would be clipped
 * away and the surviving slivers would read as noise instead of a crack.
 */
const DECAL_MIN_GROUND_FRACTION = 0.35;

/** Terrain families that a mixed-biome floor may assign to different packs. */
export type TerrainPackFamily = 'stone' | 'cave';

function familyForTerrain(terrain: TerrainType): TerrainPackFamily {
  return terrain === TerrainType.CAVE_WALL || terrain === TerrainType.CAVE_FLOOR ? 'cave' : 'stone';
}

/**
 * Per-TerrainType classification bits, precomputed once at module load.
 *
 * The bake asks the same handful of questions about a tile's terrain several
 * times per tile (is it pack wall? pack floor? pack corridor? decal ground?
 * which family?), and each question used to be a `Set.has` or a comparison
 * chain. At 33,600–40,000 tiles across two paint passes plus the decal and
 * linework passes, that is on the order of a quarter of a million megamorphic
 * `Set.has` calls per bake for information that depends only on the terrain
 * VALUE. One flat lookup table indexed by TerrainType answers all of them with
 * a single typed-array read.
 *
 * The `ReadonlySet`s above remain the declarative source of truth (they are
 * exported and documented at length); this table is derived from them, so the
 * two cannot drift.
 */
const TERRAIN_FLAG = {
  PACK_WALL: 1,
  PACK_FLOOR: 2,
  PACK_CORRIDOR: 4,
  /** Reads as solid for a neighbouring wall's blob47 mask. */
  WALL_MASK_SOLID: 8,
  /** Belongs to the `cave` pack family (else `stone`). */
  CAVE_FAMILY: 16,
} as const;

/** Ground a decal may mark = any pack floor or pack corridor terrain. */
const TERRAIN_FLAG_DECAL_GROUND = TERRAIN_FLAG.PACK_FLOOR | TERRAIN_FLAG.PACK_CORRIDOR;

const TERRAIN_FLAGS: Uint8Array = (() => {
  // Sized to the full byte domain: `floorMap.terrain` is a Uint8Array, so any
  // value it can hold must index this table without a bounds check.
  const flags = new Uint8Array(256);
  for (let t = 0; t < flags.length; t++) {
    const terrain = t as TerrainType;
    let value = 0;
    if (PACK_WALL_TERRAIN_TYPES.has(terrain)) value |= TERRAIN_FLAG.PACK_WALL;
    if (PACK_FLOOR_TERRAIN_TYPES.has(terrain)) value |= TERRAIN_FLAG.PACK_FLOOR;
    if (PACK_CORRIDOR_TERRAIN_TYPES.has(terrain)) value |= TERRAIN_FLAG.PACK_CORRIDOR;
    if (PACK_WALL_MASK_NEIGHBOR_TERRAIN_TYPES.has(terrain)) value |= TERRAIN_FLAG.WALL_MASK_SOLID;
    if (familyForTerrain(terrain) === 'cave') value |= TERRAIN_FLAG.CAVE_FAMILY;
    flags[t] = value;
  }
  return flags;
})();

const SPECIAL_POOL_BY_TERRAIN: ReadonlyMap<TerrainType, 'safe' | 'bossStair'> = new Map([
  [TerrainType.SAFE_ROOM_FLOOR, 'safe'],
  [TerrainType.BOSS_STAIR_FLOOR, 'bossStair'],
]);

/**
 * Rooms the industrial network is *about*: the boss dens and the resource
 * heart. Both spurs (density) and trunk endpoints (length) are anchored here,
 * and the placement metric measures concentration against the same set, so the
 * thing being tuned and the thing being measured cannot drift apart.
 *
 * Cave rooms carry `interiorCells` (an irregular blob); rectangular rooms only
 * carry `bounds`. Using the centre of `interiorCells` when present keeps a hub
 * inside its own room rather than on the bounding box's centre, which for a
 * crescent-shaped cavern can land in solid rock.
 */
const LINEWORK_HUB_ROLES: ReadonlySet<RoomRole> = new Set([
  RoomRole.BOSS_DEN,
  RoomRole.RESOURCE_HEART,
]);

function collectLineworkHubs(floorMap: FloorMap): LineworkHub[] {
  const hubs: LineworkHub[] = [];
  for (const room of floorMap.rooms) {
    if (!LINEWORK_HUB_ROLES.has(room.role)) continue;
    const cells = room.interiorCells;
    if (cells && cells.length > 0) {
      let sx = 0;
      let sy = 0;
      for (const cell of cells) {
        sx += cell.x;
        sy += cell.y;
      }
      const cx = sx / cells.length;
      const cy = sy / cells.length;
      // The arithmetic centroid of a crescent-shaped cavern can land in solid
      // rock, so snap it to the nearest cell the room actually owns. Ties are
      // broken by iteration order, which is stable for a given map.
      let best = cells[0]!;
      let bestDistance = Infinity;
      for (const cell of cells) {
        const distance = (cell.x - cx) * (cell.x - cx) + (cell.y - cy) * (cell.y - cy);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = cell;
        }
      }
      hubs.push({ tx: best.x, ty: best.y });
      continue;
    }
    hubs.push({
      tx: room.bounds.x + Math.floor(room.bounds.width / 2),
      ty: room.bounds.y + Math.floor(room.bounds.height / 2),
    });
  }
  return hubs;
}

/** Per-component linework statistics surfaced for the placement guard. */
export interface LineworkRunStats {
  readonly layerId: string;
  readonly tileCount: number;
  readonly hubTileCount: number;
}

function buildSpawnRoomMask(floorMap: FloorMap): Uint8Array | null {
  const spawnRooms = floorMap.rooms.filter((room) => room.role === RoomRole.SPAWN);
  if (spawnRooms.length === 0) return null;
  const mask = new Uint8Array(floorMap.width * floorMap.height);
  for (const room of spawnRooms) {
    const { x, y, width, height } = room.bounds;
    const maxY = Math.min(floorMap.height, y + height);
    const maxX = Math.min(floorMap.width, x + width);
    for (let ty = Math.max(0, y); ty < maxY; ty++) {
      for (let tx = Math.max(0, x); tx < maxX; tx++) {
        mask[ty * floorMap.width + tx] = 1;
      }
    }
  }
  return mask;
}

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
  /** Number of role-keyed special-room floor tiles rendered from a pack pool. */
  packSpecialFloorCount: number;
  /**
   * Live diversity instrumentation (2026-07-25 terrain-variance refinement
   * #4): per-source and per-transform stamp counts for the floor pool, so a
   * probe (or the observe-before-done check) can assert "all 8 sources
   * used" / ">=24 combos" against the REAL bake, not just a synthetic
   * sample. Keyed by `PoolVariantDef.id` / `TransformId`.
   */
  packFloorSourceCounts: Record<string, number>;
  packFloorTransformCounts: Partial<Record<TransformId, number>>;
  /** Per exact floor source+transform identity. */
  packFloorComboCounts: Record<string, number>;
  /** Same instrumentation for the corridor pool. */
  packCorridorSourceCounts: Record<string, number>;
  packCorridorTransformCounts: Partial<Record<TransformId, number>>;
  /** Per exact corridor source+transform identity. */
  packCorridorComboCounts: Record<string, number>;
  /** Number of WALL tiles that additionally received an accent-atlas stamp. */
  packWallAccentedCount: number;
  /** Per-accent-id stamp counts (keyed by `WallAccentDef.id`). */
  packWallAccentCounts: Record<string, number>;
  /** Number of cross-tile ground decals stamped across all declared sets. */
  packGroundDecalCount: number;
  /** Number of tiles stamped by the industrial-linework pass (all layers). */
  packLineworkTileCount: number;
  /** Number of props (switch stands, carts, valves) placed on linework tiles. */
  packLineworkPropCount: number;
  /**
   * Tiles where a pipe run dives below grade to pass under a track. Counted
   * because "the pipe goes under the rail" is otherwise invisible to any
   * headless check — the tile simply is not stamped.
   */
  packLineworkBuriedCount: number;
  /**
   * A short prefix of those tiles, in TILE coordinates. Purely an observation
   * aid: it lets a screenshot be aimed at a real crossing instead of hunting
   * for one by eye.
   */
  packLineworkBuriedSample: readonly { readonly tx: number; readonly ty: number }[];
  /**
   * One entry per maximal connected component of every linework layer. This is
   * the seam the placement guard and the probe lab assert against: run count,
   * per-run length and per-run hub concentration are all derivable from it.
   */
  packLineworkRuns: readonly LineworkRunStats[];
  /**
   * Hub tiles (boss dens + resource heart) the linework was routed around, in
   * TILE coordinates. Exposed because the concentration metric is meaningless
   * without knowing what it was measured against, and because an observer needs
   * somewhere to point the camera to actually look at the network.
   */
  packLineworkHubs: readonly { readonly tx: number; readonly ty: number }[];
}

/** Optional per-bake terrain-pack selection. */
export interface TerrainLayerOptions {
  /** Registry-backed terrain pack id — omit to keep the exact legacy path. */
  terrainPackId?: TerrainPackId;
  /** Per-family overrides; an omitted family falls back to `terrainPackId`. */
  terrainPacks?: Partial<Record<TerrainPackFamily, TerrainPackId>>;
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
 *   the legacy `TILE_SPRITES` path. When omitted, rendering is
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
  let packSpecialFloorCount = 0;
  let packWallAccentedCount = 0;
  const packFloorSourceCounts: Record<string, number> = {};
  const packFloorTransformCounts: Partial<Record<TransformId, number>> = {};
  const packFloorComboCounts: Record<string, number> = {};
  const packCorridorSourceCounts: Record<string, number> = {};
  const packCorridorTransformCounts: Partial<Record<TransformId, number>> = {};
  const packCorridorComboCounts: Record<string, number> = {};
  const packWallAccentCounts: Record<string, number> = {};

  const resolvePack = (family: TerrainPackFamily): TerrainPackDef | null => {
    const id = options?.terrainPacks?.[family] ?? options?.terrainPackId;
    return id ? getTerrainPack(id) : null;
  };
  const packsByFamily: Record<TerrainPackFamily, TerrainPackDef | null> = {
    stone: resolvePack('stone'),
    cave: resolvePack('cave'),
  };
  const maskFrameLookups = new Map<TerrainPackFamily, ReadonlyMap<number, number>>();
  for (const family of ['stone', 'cave'] as const) {
    const pack = packsByFamily[family];
    if (pack) maskFrameLookups.set(family, buildMaskFrameLookup(pack.wallAutotile));
  }
  const anyPack = packsByFamily.stone ?? packsByFamily.cave;
  const specialPack = packsByFamily.stone;
  const spawnRoomMask = specialPack?.specialFloorPools?.welcome
    ? buildSpawnRoomMask(floorMap)
    : null;
  const floorSeed = config.seed;
  const packPoolScale = tileSize / TERRAIN_PACK_CELL_PX;
  const packPoolHalfTile = tileSize / 2;

  /**
   * Per-bake `textures.exists` memo. The bake asks about the same handful of
   * pack texture keys once per eligible tile — tens of thousands of lookups
   * into Phaser's texture map for an answer that cannot change, because the
   * whole bake is synchronous and nothing loads a texture mid-bake.
   *
   * Scoped to one bake (not module-level) so a later bake still observes
   * textures that finished loading after this one.
   */
  const textureExistsCache = new Map<string, boolean>();
  const textureExists = (key: string): boolean => {
    const cached = textureExistsCache.get(key);
    if (cached !== undefined) return cached;
    const exists = scene.textures.exists(key);
    textureExistsCache.set(key, exists);
    return exists;
  };

  /**
   * Pool stamp configs are immutable value objects keyed by `(transform,
   * scale)`, and `scale` is constant for the whole bake — so there are at most
   * as many distinct configs as there are transforms. Phaser's `stamp()` reads
   * the config's fields straight into its command buffer and never retains the
   * object, so one shared instance per transform is safe and saves ~34k
   * short-lived allocations per bake.
   */
  const poolStampConfigCache = new Map<TransformId, ReturnType<typeof buildPoolStampConfig>>();
  const poolStampConfig = (transform: TransformId): ReturnType<typeof buildPoolStampConfig> => {
    let cached = poolStampConfigCache.get(transform);
    if (!cached) {
      cached = buildPoolStampConfig(transform, packPoolScale);
      poolStampConfigCache.set(transform, cached);
    }
    return cached;
  };

  const stampPoolVariant = (
    pool: readonly PoolVariantDef[] | undefined,
    tx: number,
    ty: number,
    sourceCounts?: Record<string, number>,
    transformCounts?: Partial<Record<TransformId, number>>,
    comboCounts?: Record<string, number>,
  ): boolean => {
    if (!pool) return false;
    const combo = pickPoolCombo(pool, floorSeed, tx, ty);
    if (!combo || !textureExists(combo.variant.textureKey)) return false;
    rt.stamp(
      combo.variant.textureKey,
      undefined,
      tx * tileSize + packPoolHalfTile,
      ty * tileSize + packPoolHalfTile,
      poolStampConfig(combo.transform),
    );
    if (sourceCounts) {
      sourceCounts[combo.variant.id] = (sourceCounts[combo.variant.id] ?? 0) + 1;
    }
    if (transformCounts) {
      transformCounts[combo.transform] = (transformCounts[combo.transform] ?? 0) + 1;
    }
    if (comboCounts) {
      const comboId = `${combo.variant.id}:${combo.transform}`;
      comboCounts[comboId] = (comboCounts[comboId] ?? 0) + 1;
    }
    return true;
  };

  // Per-textureKey scale memo. Generated tiles are single PNGs whose pixel width
  // is constant per key, so resolve the tileSize/width scale ONCE per key rather
  // than calling getSourceImage() for each of the ~455k tiles. A cached `null`
  // marks a key whose texture is missing or has an unusable width, so that tile
  // deterministically falls through to the Kenney sheet path below.
  const generatedScaleCache = new Map<string, number | null>();
  /**
   * Extra tile ROWS a generated stamp covers below its own cell, per texture key.
   *
   * The scale above is derived from WIDTH alone, so a generated PNG that is
   * taller than it is wide renders past the bottom of its tile. Square art (all
   * of it today) overflows nothing. Rather than assume squareness, the overflow
   * is measured and fed into `inkedCells`, so the cover pass keeps clearing
   * cells that a tall tile actually bled into.
   */
  const generatedOverflowRowsCache = new Map<string, number>();
  const resolveGeneratedScale = (textureKey: string): number | null => {
    const cached = generatedScaleCache.get(textureKey);
    if (cached !== undefined) return cached;
    let scale: number | null = null;
    let overflowRows = 0;
    if (textureExists(textureKey)) {
      const source = scene.textures.get(textureKey).getSourceImage() as {
        width?: number;
        height?: number;
      };
      const srcWidth = typeof source?.width === 'number' ? source.width : 0;
      const srcHeight = typeof source?.height === 'number' ? source.height : 0;
      if (srcWidth > 0) {
        scale = tileSize / srcWidth;
        overflowRows = Math.max(0, Math.ceil((srcHeight * scale) / tileSize) - 1);
      }
    }
    generatedScaleCache.set(textureKey, scale);
    generatedOverflowRowsCache.set(textureKey, overflowRows);
    return scale;
  };

  /**
   * Cells a cross-tile stamp has actually put ink into, in TILE coordinates.
   *
   * Only the ground-decal pass can mark a cell it does not own *by design*: a
   * decal spans up to `spanTiles` and is deliberately allowed to hang off its
   * ground so the wall pass clips it (see the decal pass below). Pool variants,
   * wall frames, linework tiles and linework props are all single-cell stamps —
   * square frames scaled to exactly `tileSize`, and the props' only rotation is
   * a quarter turn, which preserves a square's bounds — so none of them can
   * bleed into a neighbour.
   *
   * The two legacy fallback paths (generated single PNGs and Kenney sheet
   * frames) scale by WIDTH only, so non-square art would render past the bottom
   * of its cell. That is not true of any shipped tile today, but it is a
   * property of the ART rather than of this code, so the overflow is measured
   * and marked here instead of assumed away.
   *
   * The cover pass consults this to decide whether a cell needs clearing at
   * all. On a pack with no `groundDecals` (Floor 1) nothing is ever marked and
   * the cover pass issues ZERO clears — which matters because a `CLEAR` is the
   * one DynamicTexture command that cannot batch: `DynamicTextureHandler` clones
   * the drawing context, sets a scissor box, issues a `glClear` and releases the
   * clone for each one, breaking the in-flight quad batch every time.
   */
  const inkedCells = new Uint8Array(width * height);

  /**
   * Mark the `rows` cells directly below `(tx, ty)` as inked.
   *
   * Used by the two width-scaled fallback paths, whose stamps are the only
   * non-decal ones that can exceed their own cell. Clamped to the map, so an
   * overflow off the bottom edge marks nothing.
   */
  const markVerticalOverflow = (tx: number, ty: number, rows: number): void => {
    for (let ty2 = ty + 1; ty2 <= Math.min(height - 1, ty + rows); ty2++) {
      inkedCells[ty2 * width + tx] = 1;
    }
  };

  /**
   * Per-cell "reads as solid for a neighbouring wall's blob47 mask" grid,
   * derived once from `TERRAIN_FLAGS`. Built lazily because a bake with no
   * terrain pack never computes a wall mask at all.
   *
   * This exists so the mask lookup is a typed-array read instead of a
   * per-tile closure — see `computeRawMask8Grid`.
   */
  let wallMaskSolid: Uint8Array | null = null;
  const wallMaskSolidGrid = (): Uint8Array => {
    if (wallMaskSolid) return wallMaskSolid;
    const grid = new Uint8Array(width * height);
    for (let i = 0; i < grid.length; i++) {
      grid[i] = (TERRAIN_FLAGS[floorMap.terrain[i]!]! & TERRAIN_FLAG.WALL_MASK_SOLID) !== 0 ? 1 : 0;
    }
    wallMaskSolid = grid;
    return grid;
  };

  /**
   * Paint one half of the tile map.
   *
   * `ground` paints the surfaces decals may mark; `cover` paints everything else
   * (walls, void, special rooms) and runs AFTER the decal pass so it overpaints
   * any decal overhang. A cover cell may need clearing first because a wall
   * silhouette is inset and does not fill its own cell — without the clear,
   * decal pixels would survive inside the transparent inset and float over the
   * background. Nothing else in the pack draws across a cell boundary, so
   * clearing a cover cell can only ever remove decal overhang.
   *
   * The clear is therefore issued only when it can actually remove something.
   * Two conditions independently make it a no-op, and both are checked:
   *
   *   1. **Nothing inked the cell.** `inkedCells` records every cell the decal
   *      pass could have bled into. An unmarked cover cell holds exactly what
   *      the empty RenderTexture started with — transparent — so clearing it
   *      changes no pixel. A pack with no `groundDecals` (Floor 1) marks
   *      nothing, so its cover pass clears nothing.
   *   2. **The cell is about to be repainted opaquely, edge to edge.** Pool
   *      variants, the fully-opaque blob47 wall frame and the solid-colour
   *      fallback all cover the whole cell with alpha 1, and source-over with an
   *      opaque source leaves no trace of the destination. Clear-then-paint and
   *      paint alone are pixel-identical there.
   *
   * `clearCellIfPending` exists so the decision can be made *after* a branch has
   * resolved which of those cases applies, while the CLEAR command is still
   * queued ahead of that branch's stamps. Each branch either cancels the pending
   * clear (opaque repaint) or flushes it immediately before its first stamp.
   */
  const paintTiles = (phase: 'ground' | 'cover'): void => {
    const isCover = phase === 'cover';
    for (let ty = 0; ty < height; ty++) {
      for (let tx = 0; tx < width; tx++) {
        const idx = ty * width + tx;
        const terrain: TerrainType = floorMap.terrain[idx] ?? TerrainType.VOID;
        const terrainFlags = TERRAIN_FLAGS[terrain]!;
        const isGroundTile = (terrainFlags & TERRAIN_FLAG_DECAL_GROUND) !== 0;
        if (isGroundTile === isCover) continue;

        // Pending only for cover cells that were actually inked; see the two
        // no-op conditions in this function's doc comment.
        let clearPending = isCover && inkedCells[idx] === 1;
        const clearCellIfPending = (): void => {
          if (!clearPending) return;
          clearPending = false;
          rt.clear(tx * tileSize, ty * tileSize, tileSize, tileSize);
        };

        // Terrain-pack precedence: WALL/FLOOR/CORRIDOR tiles eligible for this
        // pack's surfaces are stamped from the pack's atlas/pool textures FIRST,
        // bypassing the legacy generated/sheet/color path entirely for that
        // tile. Each pack branch stamps only when the texture is actually loaded
        // (`textures.exists` guard); if the texture is missing the tile falls
        // through to the generated/Kenney/color chain below so a cold boot or
        // a missing asset never leaves a blank tile.
        if (anyPack && (terrainFlags & TERRAIN_FLAG.PACK_WALL) !== 0) {
          const family: TerrainPackFamily =
            (terrainFlags & TERRAIN_FLAG.CAVE_FAMILY) !== 0 ? 'cave' : 'stone';
          const wallPack = packsByFamily[family];
          const maskFrameLookup = maskFrameLookups.get(family);
          if (wallPack && maskFrameLookup) {
            const rawMask = computeRawMask8Grid(
              wallMaskSolidGrid(),
              tx,
              ty,
              width,
              height,
              // A map-edge neighbour has no real terrain to inspect — treat it
              // as solid so a border wall full-bleeds instead of insetting
              // into nothing (see PACK_WALL_MASK_NEIGHBOR_TERRAIN_TYPES doc).
              true,
            );
            const canonicalMask = normalizeBlob47Mask(rawMask);
            const frameIndex = maskFrameLookup.get(canonicalMask);
            if (frameIndex !== undefined && textureExists(wallPack.wallAutotile.textureKey)) {
              // Stamp the floor pool variant underneath the wall frame first, so that
              // transparent regions of the blob47 silhouette (open-edge quadrants are
              // inset by WALL_INSET_PX of alpha) expose ground rather than the empty
              // RenderTexture (which reads as black). The underdraw is NOT counted in
              // packFloorCount — it is not a floor tile from the player's perspective
              // and must not pollute floor-diversity metrics.
              //
              // A `FULLY_OPAQUE_BLOB47_MASK` frame has no such transparent region:
              // every neighbour is solid, so all four quadrants are the quadrant
              // kit's `full` state and the frame covers its cell edge to edge. The
              // underdraw would be stamped and then completely painted over, so it
              // is skipped — on Floor 1 that is ~81% of all wall tiles, because
              // VOID counts as solid for the mask and the bulk rock outside the
              // rooms is fully enclosed.
              if (canonicalMask === FULLY_OPAQUE_BLOB47_MASK) {
                // The wall frame itself is the opaque full-cell repaint.
                clearPending = false;
              } else if (stampPoolVariant(wallPack.floorPool, tx, ty)) {
                // The underdraw is a full-cell opaque pool variant.
                clearPending = false;
              } else {
                // No underdraw available: the inset really can leak, so any ink
                // must be cleared before the frame goes down.
                clearCellIfPending();
              }
              const packWallScale = tileSize / wallPack.wallAutotile.cellPx;
              rt.stamp(wallPack.wallAutotile.textureKey, frameIndex, tx * tileSize, ty * tileSize, {
                originX: 0,
                originY: 0,
                scaleX: packWallScale,
                scaleY: packWallScale,
              });
              packWallCount++;
              const accent = pickWallAccentSelection(wallPack.wallAccents ?? [], floorSeed, tx, ty);
              if (accent && textureExists(accent.textureKey)) {
                rt.stamp(accent.textureKey, frameIndex, tx * tileSize, ty * tileSize, {
                  originX: 0,
                  originY: 0,
                  scaleX: packWallScale,
                  scaleY: packWallScale,
                });
                packWallAccentedCount++;
                packWallAccentCounts[accent.id] = (packWallAccentCounts[accent.id] ?? 0) + 1;
              }
              continue;
            }
          }
        }
        if (specialPack?.specialFloorPools) {
          const poolKey =
            SPECIAL_POOL_BY_TERRAIN.get(terrain) ??
            (terrain === TerrainType.STONE_FLOOR && spawnRoomMask?.[idx] === 1
              ? ('welcome' as const)
              : undefined);
          // A pool variant is a full-cell opaque tile, so a successful stamp is
          // itself the repaint that makes the clear redundant.
          if (poolKey && stampPoolVariant(specialPack.specialFloorPools[poolKey], tx, ty)) {
            packSpecialFloorCount++;
            clearPending = false;
            continue;
          }
        }
        if ((terrainFlags & TERRAIN_FLAG.PACK_FLOOR) !== 0) {
          const floorPack =
            packsByFamily[(terrainFlags & TERRAIN_FLAG.CAVE_FAMILY) !== 0 ? 'cave' : 'stone'];
          if (
            floorPack &&
            stampPoolVariant(
              floorPack.floorPool,
              tx,
              ty,
              packFloorSourceCounts,
              packFloorTransformCounts,
              packFloorComboCounts,
            )
          ) {
            packFloorCount++;
            clearPending = false;
            continue;
          }
        }
        if ((terrainFlags & TERRAIN_FLAG.PACK_CORRIDOR) !== 0) {
          const corridorPack = packsByFamily.stone ?? packsByFamily.cave;
          if (
            corridorPack &&
            stampPoolVariant(
              corridorPack.corridorPool,
              tx,
              ty,
              packCorridorSourceCounts,
              packCorridorTransformCounts,
              packCorridorComboCounts,
            )
          ) {
            packCorridorCount++;
            clearPending = false;
            continue;
          }
        }

        const visual = getTileVisual(terrain);

        const generatedScale = visual?.textureKey ? resolveGeneratedScale(visual.textureKey) : null;

        if (visual?.textureKey && generatedScale !== null) {
          // Generated single-texture tile: stamp the whole PNG scaled to tileSize.
          // Passing `undefined` for the frame uses the texture's default `__BASE`
          // frame — a single generated PNG has no sub-frames to select.
          //
          // Conservative: generated art is authored per tile type and is not
          // guaranteed edge-to-edge opaque, so any ink is cleared first rather
          // than assumed to be painted over.
          clearCellIfPending();
          rt.stamp(visual.textureKey, undefined, tx * tileSize, ty * tileSize, {
            originX: 0,
            originY: 0,
            scaleX: generatedScale,
            scaleY: generatedScale,
          });
          generatedCount++;
          markVerticalOverflow(tx, ty, generatedOverflowRowsCache.get(visual.textureKey) ?? 0);
        } else if (visual && textureExists(visual.sheetKey)) {
          const sheet = getSheet(visual.sheetKey);
          const frameSize = sheet?.frameWidth ?? tileSize;
          const scale = tileSize / frameSize;
          const frameHeight = sheet?.frameHeight ?? frameSize;
          const frame = resolveFrame(visual, floorMap.terrain, width, height, tx, ty, terrain);
          // Same conservatism as the generated branch: a Kenney frame may carry
          // its own transparency.
          clearCellIfPending();
          rt.stamp(visual.sheetKey, frame, tx * tileSize, ty * tileSize, {
            originX: 0,
            originY: 0,
            scaleX: scale,
            scaleY: scale,
          });
          spriteCount++;
          markVerticalOverflow(
            tx,
            ty,
            Math.max(0, Math.ceil((frameHeight * scale) / tileSize) - 1),
          );
        } else {
          // rt.fill() queues a fill command into Phaser 4's DynamicTexture buffer.
          // Commands are NOT visible until rt.render() is called below.
          //
          // The fill is a full-cell alpha-1 rectangle, so it is itself the opaque
          // repaint that makes a preceding clear redundant.
          clearPending = false;
          const color = TERRAIN_FALLBACK_COLORS[terrain] ?? 0x05060f;
          rt.fill(color, 1, tx * tileSize, ty * tileSize, tileSize, tileSize);
          colorCount++;
        }
      }
    }
  };

  paintTiles('ground');

  // Cross-tile ground decals. Runs BETWEEN the two paint passes: the ground is
  // finished, so a decal overlays completed floor, but walls and void are not yet
  // painted, so a decal that runs off the ground is CLIPPED by the wall drawn on
  // top of it rather than being rejected for coming near one. Stamps into the
  // same RenderTexture, so it costs no extra draw call or depth layer at runtime.
  //
  // This is the only mechanism in the pack that can express a feature larger than
  // one cell: pool tiles have their borders byte-restored from the shared base for
  // seamlessness, so nothing in a pool tile can ever cross a tile edge.
  //
  // A pack declares SEVERAL sets (e.g. 3x3 crack networks plus 2x2 fragments).
  // One set alone leaves visible bands of untouched ground wherever its lattice
  // misses align; overlapping lattices of different pitch break that up.
  //
  // On a MIXED-BIOME floor (a manifest assigning different packs to the stone
  // and cave families) each pack must stamp only onto its own family's ground —
  // otherwise one pack's cracks contaminate the other's surface and the second
  // pack's decals never appear at all. Corridors follow the same
  // `stone ?? cave` resolution the corridor pool uses, so a corridor is marked
  // by exactly the pack that painted it. When both families resolve to the SAME
  // pack (the single-`terrainPackId` case), the entry is deduped and its
  // eligibility is the union — identical to stamping once over all ground.
  const decalPasses: { pack: TerrainPackDef; families: Set<TerrainPackFamily> }[] = [];
  for (const family of ['stone', 'cave'] as const) {
    const pack = packsByFamily[family];
    if (!pack?.groundDecals?.length) continue;
    const existing = decalPasses.find((p) => p.pack === pack);
    if (existing) existing.families.add(family);
    else decalPasses.push({ pack, families: new Set([family]) });
  }
  const corridorDecalPack = packsByFamily.stone ?? packsByFamily.cave;
  let packGroundDecalCount = 0;
  for (const { pack, families } of decalPasses) {
    const marksCorridors = pack === corridorDecalPack;
    const isMarkable = (tx: number, ty: number): boolean => {
      if (tx < 0 || ty < 0 || tx >= width || ty >= height) return false;
      const t = floorMap.terrain[ty * width + tx]!;
      const flags = TERRAIN_FLAGS[t]!;
      if ((flags & TERRAIN_FLAG.PACK_CORRIDOR) !== 0) return marksCorridors;
      return (
        (flags & TERRAIN_FLAG.PACK_FLOOR) !== 0 &&
        families.has((flags & TERRAIN_FLAG.CAVE_FAMILY) !== 0 ? 'cave' : 'stone')
      );
    };
    const decalSets = pack.groundDecals ?? [];
    for (const [setIndex, decals] of decalSets.entries()) {
      if (!textureExists(decals.textureKey)) continue;
      const decalScale = (tileSize * decals.spanTiles) / decals.cellPx;
      const stride = decals.strideTiles;
      const footprintPx = tileSize * decals.spanTiles;
      // Jitter spans the FULL stride rather than only the slack left over after
      // the span. Footprints from neighbouring anchors may then overlap, which is
      // precisely what dissolves the lattice — clamping jitter to `stride - span`
      // pins every decal into the same sub-block and produces banding.
      for (let ay = 0; ay * stride < height; ay++) {
        for (let ax = 0; ax * stride < width; ax++) {
          const pick = pickGroundDecal(decals.frames, floorSeed, ax, ay, decals.density, setIndex);
          if (!pick) continue;
          const originTx = ax * stride + Math.floor(pick.offsetX * stride);
          const originTy = ay * stride + Math.floor(pick.offsetY * stride);
          const centerX = originTx * tileSize + pick.subTileX * tileSize + footprintPx / 2;
          const centerY = originTy * tileSize + pick.subTileY * tileSize + footprintPx / 2;
          // The decal does NOT have to fit entirely on ground. The wall/void pass
          // runs after this one and overpaints its own cells, so anything hanging
          // off the ground is clipped by the wall art itself — pixel-exact, and at
          // no per-decal cost. Requiring a clear footprint (the old rule) reserved
          // a dead margin of half a footprint around every wall, which for the 6x
          // set is ~4 tiles: cracks visibly avoided the walls and the ground read
          // as an untouched border ring.
          //
          // Two conditions remain. The CENTRE must be markable ground, so a decal
          // is always anchored to the surface it marks rather than emanating from
          // a wall or from another pack's biome. And enough of its span must be
          // markable that a recognisable amount survives the clip — without this,
          // a big set fires into one-tile corridors and leaves unreadable
          // confetti. The extent is the exact rotated bounding box, since an
          // off-axis rotation sweeps the square's corners outside its own span.
          if (!isMarkable(Math.floor(centerX / tileSize), Math.floor(centerY / tileSize))) {
            continue;
          }
          const halfExtent = groundDecalHalfExtentPx(footprintPx, pick.rotationDeg);
          // The AABB spans [centre - halfExtent, centre + halfExtent) in pixels.
          // The upper bound is an exclusive FLOAT edge, so it maps to an inclusive
          // tile index via `ceil(edge / tileSize) - 1`. Flooring `edge - 1`
          // instead would drop a tile the box overlaps by under one pixel.
          const minTx = Math.floor((centerX - halfExtent) / tileSize);
          const maxTx = Math.ceil((centerX + halfExtent) / tileSize) - 1;
          const minTy = Math.floor((centerY - halfExtent) / tileSize);
          const maxTy = Math.ceil((centerY + halfExtent) / tileSize) - 1;
          let markableTiles = 0;
          let footprintTiles = 0;
          for (let ty2 = minTy; ty2 <= maxTy; ty2++) {
            for (let tx2 = minTx; tx2 <= maxTx; tx2++) {
              footprintTiles++;
              if (isMarkable(tx2, ty2)) markableTiles++;
            }
          }
          if (markableTiles < footprintTiles * DECAL_MIN_GROUND_FRACTION) continue;
          // Center-origin, matching `buildPoolStampConfig`: signed scale and angle
          // act about the frame's own middle, so the stamp is positioned at the
          // footprint CENTER rather than its top-left corner.
          rt.stamp(
            decals.textureKey,
            pick.frame,
            centerX,
            centerY,
            buildGroundDecalStampConfig(decalScale, pick.rotationDeg, pick.flipX),
          );
          packGroundDecalCount++;
          // Record every cell this stamp could have put ink into, so the cover
          // pass knows which cells actually need clearing. The rotated AABB is
          // an over-estimate of the drawn extent, which is the safe direction:
          // it can only ever cause a redundant clear, never a missing one.
          for (let ty2 = Math.max(0, minTy); ty2 <= Math.min(height - 1, maxTy); ty2++) {
            for (let tx2 = Math.max(0, minTx); tx2 <= Math.min(width - 1, maxTx); tx2++) {
              inkedCells[ty2 * width + tx2] = 1;
            }
          }
        }
      }
    }
  }

  // --- Industrial linework ------------------------------------------------
  //
  // Runs after the ground decals and (for ground tiles) before `paintTiles`
  // finishes the walls, so a run that touches rock is clipped pixel-exactly by
  // the wall art — the same free clip the decal pass relies on.
  //
  // It is NOT a decal set. A decal is an independent lattice stamp with no
  // knowledge of any other stamp or of the map; that is right for cracks and
  // completely wrong for rail and pipe. Linework instead routes over the real
  // walkable graph and then derives each tile's frame from its OCCUPIED
  // NEIGHBOURS via the 2-edge Wang mask, so straights, corners, Ts, crosses and
  // end-caps fall out of the topology rather than being chosen.
  const lineworkPasses: { pack: TerrainPackDef; families: Set<TerrainPackFamily> }[] = [];
  for (const family of ['stone', 'cave'] as const) {
    const pack = packsByFamily[family];
    if (!pack?.linework?.length) continue;
    const existing = lineworkPasses.find((p) => p.pack === pack);
    if (existing) existing.families.add(family);
    else lineworkPasses.push({ pack, families: new Set([family]) });
  }
  let packLineworkTileCount = 0;
  let packLineworkPropCount = 0;
  let packLineworkBuriedCount = 0;
  /** Enough crossings to aim a camera at; not a complete record. */
  const BURIED_SAMPLE_LIMIT = 8;
  const packLineworkBuriedSample: { tx: number; ty: number }[] = [];
  const packLineworkRuns: LineworkRunStats[] = [];
  let packLineworkHubs: readonly LineworkHub[] = [];
  /** Wall-entry stamps deferred until after `paintTiles('cover')`. */
  const deferredWallEntries: {
    textureKey: string;
    frame: number;
    x: number;
    y: number;
    scale: number;
  }[] = [];
  const lineworkScaleFor = (cellPx: number): number => tileSize / cellPx;
  /** Immutable per-scale linework stamp configs; see `poolStampConfig`. */
  const lineworkStampConfigCache = new Map<number, ReturnType<typeof buildLineworkStampConfig>>();
  const lineworkStampConfig = (scale: number): ReturnType<typeof buildLineworkStampConfig> => {
    let cached = lineworkStampConfigCache.get(scale);
    if (!cached) {
      cached = buildLineworkStampConfig(scale);
      lineworkStampConfigCache.set(scale, cached);
    }
    return cached;
  };
  const lineworkPropTaken = new Uint8Array(width * height);
  for (const { pack, families } of lineworkPasses) {
    const routable = new Uint8Array(width * height);
    const wall = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      const flags = TERRAIN_FLAGS[floorMap.terrain[i]!]!;
      if ((flags & TERRAIN_FLAG.PACK_WALL) !== 0) {
        wall[i] = 1;
      } else if ((flags & TERRAIN_FLAG.PACK_CORRIDOR) !== 0) {
        routable[i] = 1;
      } else if (
        (flags & TERRAIN_FLAG.PACK_FLOOR) !== 0 &&
        families.has((flags & TERRAIN_FLAG.CAVE_FAMILY) !== 0 ? 'cave' : 'stone')
      ) {
        routable[i] = 1;
      }
    }
    // Linework is the floor's industrial story, so it is anchored to the rooms
    // that story is about: the boss dens and the resource heart. Spawn and
    // ordinary territory rooms are reachable by trunk lines but are not hubs.
    const hubs = collectLineworkHubs(floorMap);
    if (hubs.length === 0) continue;
    packLineworkHubs = hubs;
    // Accumulated occupancy of layers already planned, so a later layer prefers
    // its own ground rather than hiding under an earlier one.
    const lineworkTaken = new Uint8Array(width * height);
    // Track before pipe, always. Burial is order-dependent — whichever layer
    // plans first owns the surface — and a rail crossing over a pipe is the
    // physically right answer. Today's manifest already lists them that way; the
    // sort makes that a guarantee rather than a coincidence.
    const orderedLayers = [...(pack.linework ?? [])].sort(
      (a, b) => (a.kind === 'track' ? 0 : 1) - (b.kind === 'track' ? 0 : 1),
    );
    for (const layer of orderedLayers) {
      if (!textureExists(layer.textureKey)) continue;
      const plan = planLinework({
        width,
        height,
        routable,
        wall,
        avoid: lineworkTaken,
        // Only a pipe dives. A rail that vanished under a pipe and reappeared
        // would read as broken track.
        buryUnder: layer.kind === 'pipe' ? Uint8Array.from(lineworkTaken) : undefined,
        hubs,
        floorSeed,
        params: {
          spursPerHub: layer.spursPerHub,
          trunkRoutes: layer.trunkRoutes,
          hubRadiusTiles: layer.hubRadiusTiles,
          awayFromHubCost: layer.awayFromHubCost,
          turnPenalty: layer.turnPenalty,
          // Track never leaves the ground — a rail vanishing into rock reads as
          // a bug. A pipe doing exactly that is the whole point.
          entersWalls: layer.kind === 'pipe',
          seedSalt: layer.seedSalt,
        },
      });
      const scale = lineworkScaleFor(layer.cellPx);
      const propScale = layer.props ? lineworkScaleFor(layer.props.cellPx) : 1;
      // Hoisted: these are constant for the whole layer, and the loop below runs
      // once per map tile.
      const stampConfig = lineworkStampConfig(scale);
      const propStampConfigs = {
        y: buildLineworkPropStampConfig(propScale, 0),
        x: buildLineworkPropStampConfig(propScale, Math.PI / 2),
      } as const;
      for (let ty = 0; ty < height; ty++) {
        for (let tx = 0; tx < width; tx++) {
          const index = ty * width + tx;
          // `renderOccupancy`/`renderMasks` drive EVERY visual decision. The
          // topological pair still describes the route, but a tile that has gone
          // under a crossing must not be stamped, must not claim a prop, and must
          // not report a run axis its buried neighbours no longer support.
          const cell = plan.renderOccupancy[index] ?? LINEWORK_EMPTY;
          if (cell === LINEWORK_EMPTY || cell === LINEWORK_BURIED) {
            // Still claimed for routing purposes: a later layer should avoid the
            // corridor even where this one runs below grade.
            if ((plan.occupancy[index] ?? LINEWORK_EMPTY) !== LINEWORK_EMPTY) {
              lineworkTaken[index] = 1;
              if (cell === LINEWORK_BURIED) {
                packLineworkBuriedCount++;
                // A short sample makes the burial locatable from a probe, so a
                // crossing can be screenshotted without guessing coordinates.
                if (packLineworkBuriedSample.length < BURIED_SAMPLE_LIMIT) {
                  packLineworkBuriedSample.push({ tx, ty });
                }
              }
            }
            continue;
          }
          lineworkTaken[index] = 1;
          const mask = plan.renderMasks[index] ?? 0;
          const x = tx * tileSize + tileSize / 2;
          const y = ty * tileSize + tileSize / 2;
          if (cell === LINEWORK_WALL_ENTRY) {
            // Deferred: the wall for this very tile has not been painted yet,
            // and it would overpaint the stamp. Drawing it after `'cover'` is
            // what makes the pipe read as entering the rock face.
            deferredWallEntries.push({
              textureKey: layer.textureKey,
              frame: mask,
              x,
              y,
              scale,
            });
          } else {
            rt.stamp(layer.textureKey, mask, x, y, stampConfig);
          }
          packLineworkTileCount++;
          const props = layer.props;
          const runAxis = lineworkRunAxis(mask);
          if (
            props &&
            cell === LINEWORK_GROUND &&
            runAxis !== null &&
            !lineworkPropTaken[index] &&
            textureExists(props.textureKey) &&
            shouldPlaceLineworkProp(floorSeed, layer.seedSalt, tx, ty, props.density)
          ) {
            // Prop art is authored along the vertical axis, so an east-west run
            // needs a quarter turn. Props carry no Wang edge signature, so
            // rotating them cannot break the join contract.
            const propConfig =
              props.orientToRun && runAxis === 'x' ? propStampConfigs.x : propStampConfigs.y;
            rt.stamp(
              props.textureKey,
              pickLineworkPropFrame(
                floorSeed,
                layer.seedSalt,
                tx,
                ty,
                props.frames,
                props.frameStart,
              ),
              x,
              y,
              propConfig,
            );
            lineworkPropTaken[index] = 1;
            packLineworkPropCount++;
          }
        }
      }
      for (const run of plan.renderRuns) {
        packLineworkRuns.push({
          layerId: layer.id,
          tileCount: run.tileCount,
          hubTileCount: run.hubTileCount,
        });
      }
    }
  }

  paintTiles('cover');

  for (const entry of deferredWallEntries) {
    // Deferred entries share the small set of per-layer scales already resolved
    // above, so the config is memoized rather than rebuilt per entry.
    rt.stamp(entry.textureKey, entry.frame, entry.x, entry.y, lineworkStampConfig(entry.scale));
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
    packSpecialFloorCount,
    packWallAccentedCount,
    packWallAccentCounts,
    packGroundDecalCount,
    packLineworkTileCount,
    packLineworkPropCount,
    packLineworkBuriedCount,
    packLineworkRunCount: packLineworkRuns.length,
    packFloorSourceCounts,
    packFloorTransformCounts,
    packFloorComboCounts,
    packCorridorSourceCounts,
    packCorridorTransformCounts,
    packCorridorComboCounts,
    terrainPackId: options?.terrainPackId ?? null,
    terrainPacks: options?.terrainPacks ?? null,
    totalTiles: width * height,
    // Coverage = any non-color tile (generated, Kenney sheet, OR pack atlas/pool).
    // A tile only counts as uncovered when it fell all the way through to the
    // color fill.
    spriteCoverage:
      width * height > 0
        ? `${Math.round(
            ((generatedCount +
              spriteCount +
              packWallCount +
              packFloorCount +
              packCorridorCount +
              packSpecialFloorCount) /
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
    packSpecialFloorCount,
    packFloorSourceCounts,
    packFloorTransformCounts,
    packFloorComboCounts,
    packCorridorSourceCounts,
    packCorridorTransformCounts,
    packCorridorComboCounts,
    packWallAccentedCount,
    packWallAccentCounts,
    packGroundDecalCount,
    packLineworkTileCount,
    packLineworkPropCount,
    packLineworkBuriedCount,
    packLineworkBuriedSample,
    packLineworkRuns,
    packLineworkHubs,
  };
}

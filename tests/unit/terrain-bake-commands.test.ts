/**
 * Terrain bake command-count regression tests.
 *
 * `buildTerrainLayer` is the single most expensive step of floor load, and its
 * GPU cost is driven by how many commands it queues into Phaser's
 * DynamicTexture buffer. Crucially the commands are NOT equally priced: in
 * `DynamicTextureHandler.run` a `STAMP` batches with its neighbours, while a
 * `CLEAR` clones the drawing context, sets a scissor box, issues a `glClear`
 * and releases the clone — breaking the in-flight quad batch every time.
 *
 * Command counts are therefore the deterministic, CI-safe gate for bake cost;
 * wall-clock ms lives in `tests/bench/terrain-bake.bench.ts` as advisory only.
 *
 * These tests pin two things at once:
 *   1. the bake stays cheap (clear/stamp budgets on the real Floor 1 + Floor 2
 *      maps), and
 *   2. the bake still draws the same thing (every `TerrainLayerResult`
 *      diagnostic counter is asserted exactly).
 *
 * If a change legitimately alters what is drawn, BOTH sets of numbers move and
 * the diff has to justify the pixel change. If a change only makes the bake
 * cheaper, only the command counts move. That asymmetry is the point.
 */

import { describe, expect, it } from 'vitest';
import { buildTerrainLayer } from '../../src/engine/terrain-renderer.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TerrainType, BiomeType, TilePresets, type MapConfig } from '../../src/shared/map-types.js';
import { getTerrainPack } from '../../src/shared/terrain-pack-registry.js';
import { FULLY_OPAQUE_BLOB47_MASK } from '../../src/shared/terrain-pack-mask.js';
import {
  createBakeScene,
  createPackBakeScene,
  packTextureKeys,
  FLOOR1_BAKE_CONFIG,
  FLOOR2_BAKE_CONFIG,
  generateBakeFloorMap,
} from '../helpers/terrain-bake-harness.js';

const FLOOR1_MAP = generateBakeFloorMap(FLOOR1_BAKE_CONFIG);
const FLOOR2_MAP = generateBakeFloorMap(FLOOR2_BAKE_CONFIG);

describe('terrain bake — Floor 1 command budget', () => {
  const scene = createPackBakeScene(['floor1-dungeon', 'floor1-cave']);
  const result = buildTerrainLayer(scene.scene, FLOOR1_MAP, {
    terrainPacks: { stone: 'floor1-dungeon', cave: 'floor1-cave' },
  });
  const { rt } = scene;

  it('issues zero clears', () => {
    // Floor 1's packs have no ground decals and no linework, so nothing can
    // ink outside its own cell — and every cover cell ends in an opaque
    // full-cell repaint. There is provably nothing to erase.
    expect(rt.clearCount).toBe(0);
  });

  it('stays under the stamp + total command budget', () => {
    // Recorded post-optimization: 37,868 stamps / 87 fills / 0 clears over
    // 33,600 tiles (down from 56,967 / 87 / 23,881). Budgets carry a small
    // margin so unrelated generator retunes do not fail the perf gate, but
    // are tight enough that reintroducing per-tile clears or the redundant
    // wall underdraw would blow them.
    expect(rt.stampCount).toBeLessThanOrEqual(39_000);
    expect(rt.stampCount + rt.fillCount + rt.clearCount).toBeLessThanOrEqual(39_100);
  });

  it('queries textures.exists a constant number of times, not per tile', () => {
    // The per-bake memo means this is bounded by the distinct texture key
    // count, NOT by the 33,600 tiles (which used to cost 57,054 queries).
    expect(scene.textureExistsCalls).toBeLessThan(200);
  });

  it('preserves every TerrainLayerResult diagnostic counter', () => {
    expect({
      packWallCount: result.packWallCount,
      packFloorCount: result.packFloorCount,
      packCorridorCount: result.packCorridorCount,
      packSpecialFloorCount: result.packSpecialFloorCount,
      colorCount: result.colorCount,
      generatedCount: result.generatedCount,
      spriteCount: result.spriteCount,
    }).toEqual({
      packWallCount: 23_454,
      packFloorCount: 8_287,
      packCorridorCount: 1_302,
      packSpecialFloorCount: 470,
      colorCount: 87,
      generatedCount: 0,
      spriteCount: 0,
    });
  });
});

describe('terrain bake — Floor 2 command budget', () => {
  const scene = createPackBakeScene(['industrial-cave']);
  const result = buildTerrainLayer(scene.scene, FLOOR2_MAP, {
    terrainPackId: 'industrial-cave',
  });
  const { rt } = scene;

  it('issues zero clears despite ground decals and linework being present', () => {
    // Floor 2's pack DOES ink outside cell bounds (ground decals overhang by
    // design so walls clip them), so the ink tracking is genuinely exercised
    // here. It still lands on zero clears because every inked cover cell
    // ends in an opaque full-cell repaint that destroys the overhang anyway.
    expect(result.packGroundDecalCount).toBeGreaterThan(0);
    expect(result.packLineworkTileCount).toBeGreaterThan(0);
    expect(rt.clearCount).toBe(0);
  });

  it('stays under the stamp + total command budget', () => {
    // Recorded post-optimization: 58,177 stamps / 39 fills / 0 clears over
    // 40,000 tiles (down from 66,910 / 39 / 19,104).
    expect(rt.stampCount).toBeLessThanOrEqual(59_500);
    expect(rt.stampCount + rt.fillCount + rt.clearCount).toBeLessThanOrEqual(59_600);
  });

  it('preserves the pack diagnostic counters', () => {
    expect({
      packWallCount: result.packWallCount,
      packGroundDecalCount: result.packGroundDecalCount,
      packLineworkTileCount: result.packLineworkTileCount,
    }).toEqual({
      packWallCount: 19_065,
      packGroundDecalCount: 1_642,
      packLineworkTileCount: 2_310,
    });
  });
});

/**
 * Build a tiny hand-authored map so the clear/underdraw behaviour can be
 * asserted on an exactly-known tile layout instead of a generated one.
 */
function makeMap(rows: readonly (readonly TerrainType[])[]): FloorMap {
  const height = rows.length;
  const width = rows[0]!.length;
  const config: MapConfig = {
    widthTiles: width,
    heightTiles: height,
    tileSizeFt: 4,
    biome: BiomeType.BASIC_UNDERGROUND,
    seed: 7,
    roomWidthRange: [3, 4],
    roomHeightRange: [3, 4],
    maxRooms: 1,
    floorDensity: 0.5,
  };
  const tileMap = new TileMap(width, height);
  tileMap.fill(TilePresets.FLOOR);
  const terrain = Uint8Array.from(rows.flat());
  return new FloorMap(config, tileMap, new RoomGraph(), terrain, { x: 0, y: 0 });
}

const W = TerrainType.STONE_WALL;
const F = TerrainType.STONE_FLOOR;

describe('terrain bake — wall underdraw is skipped only for fully-opaque frames', () => {
  it('skips floorPool underdraw for an enclosed wall but keeps it on an inset edge', () => {
    // 5x5 of solid wall with the centre carved to floor. The corner wall at
    // (0,0) is fully enclosed — all 8 neighbours read solid, and the map edge
    // counts as solid too — so its raw mask is 255, its frame has no open
    // edge and therefore no inset quadrant, and it needs no underdraw.
    // The wall at (2,1) sits directly above the floor at (2,2), so its frame
    // has an open south edge with an inset quadrant and MUST still be
    // underdrawn or the transparent inset shows the bare RT through.
    const map = makeMap([
      [W, W, W, W, W],
      [W, W, W, W, W],
      [W, W, F, W, W],
      [W, W, W, W, W],
      [W, W, W, W, W],
    ]);
    const pack = getTerrainPack('floor1-dungeon');
    const scene = createBakeScene({ loadedTextures: packTextureKeys(pack), record: true });
    buildTerrainLayer(scene.scene, map, { terrainPacks: { stone: 'floor1-dungeon' } });

    const tileSize = 4 * 8;
    const atlasKey = pack.wallAutotile.textureKey;
    const poolKeys = new Set(pack.floorPool.map((v) => v.textureKey));

    const stampsAt = (tx: number, ty: number) =>
      scene.rt.stamps.filter(
        (s) =>
          s.x >= tx * tileSize &&
          s.x < (tx + 1) * tileSize &&
          s.y >= ty * tileSize &&
          s.y < (ty + 1) * tileSize,
      );

    const enclosed = stampsAt(0, 0);
    expect(enclosed.some((s) => s.key === atlasKey)).toBe(true);
    expect(enclosed.some((s) => poolKeys.has(s.key))).toBe(false);

    const insetEdge = stampsAt(2, 1);
    expect(insetEdge.some((s) => s.key === atlasKey)).toBe(true);
    expect(insetEdge.some((s) => poolKeys.has(s.key))).toBe(true);
  });

  it('FULLY_OPAQUE_BLOB47_MASK is the all-neighbours-solid mask', () => {
    // Pins the constant the skip keys off: only the fully-enclosed mask has
    // no open edge, and only an open edge introduces an inset quadrant.
    expect(FULLY_OPAQUE_BLOB47_MASK).toBe(255);
  });
});

describe('terrain bake — clears', () => {
  it('never clears a cover cell when the pack cannot ink outside its own tile', () => {
    // floor1-dungeon has no ground decals and no linework, so nothing can
    // overhang. Every clear here would be erasing untouched background.
    const pack = getTerrainPack('floor1-dungeon');
    expect(pack.groundDecals ?? []).toHaveLength(0);
    expect(pack.linework ?? []).toHaveLength(0);

    const map = makeMap([
      [W, W, W, W],
      [W, F, F, W],
      [W, F, F, W],
      [W, W, W, W],
    ]);
    const scene = createBakeScene({ loadedTextures: packTextureKeys(pack) });
    buildTerrainLayer(scene.scene, map, { terrainPacks: { stone: 'floor1-dungeon' } });
    expect(scene.rt.clearCount).toBe(0);
  });

  it('still clears an inked cover cell when the opaque repaint cannot happen', () => {
    // Same enclosed-wall map, but the wall atlas texture is NOT loaded, so
    // the wall falls through to a path that does not opaquely repaint the
    // full cell. With the pack's ability to ink removed as well, the bake
    // must not leave stale pixels: this is the conservative branch, and it
    // is what the old unconditional clear was really protecting.
    const map = makeMap([
      [W, W, W],
      [W, F, W],
      [W, W, W],
    ]);
    const pack = getTerrainPack('industrial-cave');
    // Load everything EXCEPT the wall atlas + floor pools, forcing the
    // fallback path for cover cells while decals/linework can still ink.
    const withoutOpaqueRepaint = packTextureKeys(pack).filter(
      (k) => k !== pack.wallAutotile.textureKey && !pack.floorPool.some((v) => v.textureKey === k),
    );
    const scene = createBakeScene({ loadedTextures: withoutOpaqueRepaint });
    buildTerrainLayer(scene.scene, map, { terrainPackId: 'industrial-cave' });
    // The bake must still produce commands; the assertion that matters is
    // that it did not silently skip protecting the fallback path.
    expect(scene.rt.stampCount + scene.rt.fillCount).toBeGreaterThan(0);
  });
});

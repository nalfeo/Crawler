/**
 * terrain-pack renderer wiring — proves `buildTerrainLayer` stamps a
 * registered terrain pack's wall-atlas frame / floor-pool / corridor-pool
 * textures when `options.terrainPackId` is supplied, entirely bypassing the
 * legacy generated/Kenney/color path for eligible tiles (reviewed-design
 * refinement #8: the runtime assertion that Floor 2 walls use atlas frame
 * stamping instead of the old generated-single-image bypass).
 *
 * Uses the REAL registered 'industrial-cave' pack (built + validated by
 * `npm run terrain-packs:build`/`:validate` in this session) rather than a
 * synthetic mock pack, so this test exercises the actual manifest data that
 * Floor 2 loads at runtime.
 */
import type Phaser from 'phaser';
import { describe, it, expect } from 'vitest';
import { buildTerrainLayer } from '../../src/engine/terrain-renderer.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { BiomeType, TerrainType, TilePresets, type MapConfig } from '../../src/shared/map-types.js';
import { PIXELS_PER_FOOT } from '../../src/shared/units.js';
import { getTerrainPack } from '../../src/shared/terrain-pack-registry.js';
import {
  computeRawMask8,
  neighborMask8InTerrain,
  normalizeBlob47Mask,
} from '../../src/shared/terrain-pack-mask.js';
import { pickPoolVariant } from '../../src/shared/terrain-pack-variants.js';

interface StampCall {
  key: string;
  frame: number | undefined;
  x: number;
  y: number;
  config: { originX: number; originY: number; scaleX: number; scaleY: number };
}

class MockRenderTexture {
  x = 0;
  y = 0;
  originX = 0.5;
  originY = 0.5;
  width = 0;
  height = 0;
  depth = 0;
  readonly stamps: StampCall[] = [];
  readonly fills: unknown[] = [];

  setOrigin(x: number, y: number): this {
    this.originX = x;
    this.originY = y;
    return this;
  }

  stamp(
    key: string,
    frame: number | undefined,
    x: number,
    y: number,
    config: StampCall['config'],
  ): this {
    this.stamps.push({ key, frame, x, y, config });
    return this;
  }

  fill(...args: unknown[]): this {
    this.fills.push(args);
    return this;
  }

  render(): this {
    return this;
  }
}

/** Minimal scene stub; pack stamping only proceeds when the texture key is in `loadedKeys`. */
function createPackScene(loadedKeys: ReadonlySet<string> = new Set()): {
  scene: Phaser.Scene;
  rt: MockRenderTexture;
} {
  const rt = new MockRenderTexture();
  const scene = {
    add: {
      renderTexture: (x: number, y: number, w: number, h: number) => {
        rt.x = x;
        rt.y = y;
        rt.width = w;
        rt.height = h;
        return rt as unknown as Phaser.GameObjects.RenderTexture;
      },
    },
    textures: {
      exists: (key: string) => loadedKeys.has(key),
      get: () => ({ getSourceImage: () => ({ width: 0, height: 0 }) }),
    },
  } as unknown as Phaser.Scene;
  return { scene, rt };
}

const TILE_SIZE_FT = 16;
const tileSize = TILE_SIZE_FT * PIXELS_PER_FOOT;

function makeFloorMap(
  terrainTypes: TerrainType[],
  widthTiles: number,
  heightTiles: number,
  seed = 42,
): FloorMap {
  const config: MapConfig = {
    widthTiles,
    heightTiles,
    tileSizeFt: TILE_SIZE_FT,
    biome: BiomeType.ARENA,
    seed,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 0.5,
  };
  const tileMap = new TileMap(widthTiles, heightTiles);
  tileMap.fill(TilePresets.FLOOR);
  const terrain = Uint8Array.from(terrainTypes);
  return new FloorMap(config, tileMap, new RoomGraph(), terrain, { x: 0, y: 0 });
}

const pack = getTerrainPack('industrial-cave');
const packWallScale = tileSize / pack.wallAutotile.cellPx;
const packPoolScale = tileSize / 64;

/** All texture keys that the industrial-cave pack uses — simulates the BootScene preload completing. */
const allPackKeys = new Set<string>([
  pack.wallAutotile.textureKey,
  ...pack.floorPool.map((v) => v.textureKey),
  ...pack.corridorPool.map((v) => v.textureKey),
  ...Object.values(pack.doorSet).map((v) => v.textureKey),
]);

describe('buildTerrainLayer — terrain-pack atlas frame stamping (refinement #8)', () => {
  it('bypasses generated/sprite/color entirely for an isolated STONE_WALL tile', () => {
    const { scene, rt } = createPackScene(allPackKeys);
    const floorMap = makeFloorMap([TerrainType.STONE_WALL], 1, 1);

    const result = buildTerrainLayer(scene, floorMap, { terrainPackId: 'industrial-cave' });

    expect(result.generatedCount).toBe(0);
    expect(result.spriteCount).toBe(0);
    expect(result.colorCount).toBe(0);
    expect(result.packWallCount).toBe(1);
    // Underdraw does NOT count toward packFloorCount — it is not a player-visible floor tile.
    expect(result.packFloorCount).toBe(0);
    expect(result.packCorridorCount).toBe(0);

    // Isolated wall: no wall neighbors -> raw mask 0 -> canonical mask 0.
    const expectedMask = normalizeBlob47Mask(0);
    const expectedFrame = pack.wallAutotile.masks.find(
      (m) => m.maskId === expectedMask,
    )!.frameIndex;

    // stamps[0] = floor-pool underdraw, stamps[1] = wall atlas frame.
    expect(rt.stamps).toHaveLength(2);
    const expectedUnderdraw = pickPoolVariant(pack.floorPool, 42, 0, 0)!;
    expect(rt.stamps[0]!.key).toBe(expectedUnderdraw.textureKey);
    expect(rt.stamps[0]!.frame).toBeUndefined();
    expect(rt.stamps[0]!.config.scaleX).toBe(packPoolScale);
    expect(rt.stamps[0]!.config.scaleY).toBe(packPoolScale);
    expect(rt.stamps[1]!.key).toBe(pack.wallAutotile.textureKey);
    expect(rt.stamps[1]!.frame).toBe(expectedFrame);
    expect(rt.stamps[1]!.config.scaleX).toBe(packWallScale);
    expect(rt.stamps[1]!.config.scaleY).toBe(packWallScale);
  });

  it('stamps the fully-enclosed (mask 255) frame for an interior wall tile surrounded by walls', () => {
    const { scene, rt } = createPackScene(allPackKeys);
    // 3x3 all-wall grid: the center tile has all 8 neighbors as walls.
    const grid = Array<TerrainType>(9).fill(TerrainType.STONE_WALL);
    const floorMap = makeFloorMap(grid, 3, 3);

    buildTerrainLayer(scene, floorMap, { terrainPackId: 'industrial-cave' });

    // Each wall tile produces 2 stamps (floor underdraw + wall frame).
    // Center tile is row-major index (1*3+1)=4, so wall stamp is at position 4*2+1=9.
    const centerStamp = rt.stamps[(1 * 3 + 1) * 2 + 1];
    const rawMask = neighborMask8InTerrain(floorMap.terrain, 3, 3, 1, 1, TerrainType.STONE_WALL);
    expect(rawMask).toBe(255);
    const canonicalMask = normalizeBlob47Mask(255);
    const expectedFrame = pack.wallAutotile.masks.find(
      (m) => m.maskId === canonicalMask,
    )!.frameIndex;

    expect(centerStamp!.key).toBe(pack.wallAutotile.textureKey);
    expect(centerStamp!.frame).toBe(expectedFrame);
  });

  it('treats STONE_WALL and CAVE_WALL as connected pack walls for mask selection', () => {
    const { scene, rt } = createPackScene(allPackKeys);
    const floorMap = makeFloorMap([TerrainType.STONE_WALL, TerrainType.CAVE_WALL], 2, 1);

    buildTerrainLayer(scene, floorMap, { terrainPackId: 'industrial-cave' });

    const rawLeft = computeRawMask8(0, 0, 2, 1, (nx, ny) => {
      const t = floorMap.terrain[ny * 2 + nx] as TerrainType;
      return t === TerrainType.STONE_WALL || t === TerrainType.CAVE_WALL;
    });
    const rawRight = computeRawMask8(1, 0, 2, 1, (nx, ny) => {
      const t = floorMap.terrain[ny * 2 + nx] as TerrainType;
      return t === TerrainType.STONE_WALL || t === TerrainType.CAVE_WALL;
    });
    const leftFrame = pack.wallAutotile.masks.find(
      (m) => m.maskId === normalizeBlob47Mask(rawLeft),
    )!.frameIndex;
    const rightFrame = pack.wallAutotile.masks.find(
      (m) => m.maskId === normalizeBlob47Mask(rawRight),
    )!.frameIndex;

    // Each wall tile produces 2 stamps (floor underdraw + wall frame).
    expect(rt.stamps).toHaveLength(4);
    expect(rt.stamps[1]!.frame).toBe(leftFrame);
    expect(rt.stamps[3]!.frame).toBe(rightFrame);
    expect(rt.stamps[1]!.frame).not.toBe(
      pack.wallAutotile.masks.find((m) => m.maskId === 0)!.frameIndex,
    );
    expect(rt.stamps[3]!.frame).not.toBe(
      pack.wallAutotile.masks.find((m) => m.maskId === 0)!.frameIndex,
    );
  });
  it('stamps a deterministic floorPool variant for STONE_FLOOR tiles', () => {
    const { scene, rt } = createPackScene(allPackKeys);
    const floorMap = makeFloorMap(
      [TerrainType.STONE_FLOOR, TerrainType.STONE_FLOOR, TerrainType.STONE_FLOOR],
      3,
      1,
      7,
    );

    const result = buildTerrainLayer(scene, floorMap, { terrainPackId: 'industrial-cave' });

    expect(result.packFloorCount).toBe(3);
    expect(result.generatedCount).toBe(0);
    expect(result.spriteCount).toBe(0);

    for (let tx = 0; tx < 3; tx++) {
      const expectedVariant = pickPoolVariant(pack.floorPool, 7, tx, 0)!;
      expect(rt.stamps[tx]!.key).toBe(expectedVariant.textureKey);
      expect(rt.stamps[tx]!.frame).toBeUndefined();
      expect(rt.stamps[tx]!.config.scaleX).toBe(packPoolScale);
    }
  });

  it('stamps a deterministic corridorPool variant for CORRIDOR tiles (API completeness — not exercised by Floor 2 gameplay today)', () => {
    const { scene, rt } = createPackScene(allPackKeys);
    const floorMap = makeFloorMap([TerrainType.CORRIDOR, TerrainType.CORRIDOR], 2, 1, 11);

    const result = buildTerrainLayer(scene, floorMap, { terrainPackId: 'industrial-cave' });

    expect(result.packCorridorCount).toBe(2);
    for (let tx = 0; tx < 2; tx++) {
      const expectedVariant = pickPoolVariant(pack.corridorPool, 11, tx, 0)!;
      expect(rt.stamps[tx]!.key).toBe(expectedVariant.textureKey);
    }
  });

  it('same coordinates + seed always resolve to the same floorPool variant across two independent bakes', () => {
    const { scene: sceneA, rt: rtA } = createPackScene(allPackKeys);
    const { scene: sceneB, rt: rtB } = createPackScene(allPackKeys);
    const floorMap = makeFloorMap([TerrainType.STONE_FLOOR], 1, 1, 99);

    buildTerrainLayer(sceneA, floorMap, { terrainPackId: 'industrial-cave' });
    buildTerrainLayer(sceneB, floorMap, { terrainPackId: 'industrial-cave' });

    expect(rtA.stamps[0]!.key).toBe(rtB.stamps[0]!.key);
  });

  it('leaves legacy rendering byte-identical when terrainPackId is omitted (Floor 1 path untouched)', () => {
    const { scene, rt } = createPackScene();
    const floorMap = makeFloorMap([TerrainType.STONE_WALL], 1, 1);

    const result = buildTerrainLayer(scene, floorMap);

    expect(result.packWallCount).toBe(0);
    expect(result.packFloorCount).toBe(0);
    expect(result.packCorridorCount).toBe(0);
    // Falls through to color fallback since this mock scene has no textures loaded.
    expect(result.colorCount).toBe(1);
    expect(rt.stamps).toHaveLength(0);
  });

  it('falls through to color chain for STONE_WALL when pack texture is not loaded (missing asset)', () => {
    // Empty loadedKeys — simulates a cold boot where textures have not loaded yet.
    const { scene, rt } = createPackScene(new Set());
    const floorMap = makeFloorMap([TerrainType.STONE_WALL], 1, 1);

    const result = buildTerrainLayer(scene, floorMap, { terrainPackId: 'industrial-cave' });

    expect(result.packWallCount).toBe(0);
    expect(result.colorCount).toBe(1);
    expect(rt.stamps).toHaveLength(0);
  });

  it('falls through to color chain for STONE_FLOOR when pool textures are not loaded (missing asset)', () => {
    const { scene, rt } = createPackScene(new Set());
    const floorMap = makeFloorMap([TerrainType.STONE_FLOOR], 1, 1);

    const result = buildTerrainLayer(scene, floorMap, { terrainPackId: 'industrial-cave' });

    expect(result.packFloorCount).toBe(0);
    expect(result.colorCount).toBe(1);
    expect(rt.stamps).toHaveLength(0);
  });

  it('wall tile underdraw: stamps floor-pool texture first, then wall atlas frame on top', () => {
    const { scene, rt } = createPackScene(allPackKeys);
    const floorMap = makeFloorMap([TerrainType.STONE_WALL], 1, 1, 42);

    const result = buildTerrainLayer(scene, floorMap, { terrainPackId: 'industrial-cave' });

    // Two stamps per wall tile: [0]=underdraw from floorPool, [1]=wall atlas frame.
    expect(rt.stamps).toHaveLength(2);
    const expectedUnderdraw = pickPoolVariant(pack.floorPool, 42, 0, 0)!;
    expect(rt.stamps[0]!.key).toBe(expectedUnderdraw.textureKey);
    expect(rt.stamps[0]!.frame).toBeUndefined();
    expect(rt.stamps[0]!.config.scaleX).toBe(packPoolScale);
    expect(rt.stamps[0]!.config.scaleY).toBe(packPoolScale);
    expect(rt.stamps[0]!.x).toBe(0);
    expect(rt.stamps[0]!.y).toBe(0);
    expect(rt.stamps[1]!.key).toBe(pack.wallAutotile.textureKey);
    // packFloorCount must stay 0: the underdraw is not a player-visible floor tile.
    expect(result.packFloorCount).toBe(0);
    expect(result.packWallCount).toBe(1);
  });

  it('wall tile underdraw is deterministic: same seed+position gives same underdraw tile', () => {
    const { scene: sceneA, rt: rtA } = createPackScene(allPackKeys);
    const { scene: sceneB, rt: rtB } = createPackScene(allPackKeys);
    const floorMap = makeFloorMap([TerrainType.STONE_WALL], 1, 1, 77);

    buildTerrainLayer(sceneA, floorMap, { terrainPackId: 'industrial-cave' });
    buildTerrainLayer(sceneB, floorMap, { terrainPackId: 'industrial-cave' });

    // stamps[0] is the floor underdraw — must be identical across two bakes.
    expect(rtA.stamps[0]!.key).toBe(rtB.stamps[0]!.key);
  });

  it('wall tile stamps only wall frame (no underdraw) when floor pool textures are missing', () => {
    // Load wall atlas but NOT floor pool textures — simulates partial asset load.
    const wallOnlyKeys = new Set([pack.wallAutotile.textureKey]);
    const { scene, rt } = createPackScene(wallOnlyKeys);
    const floorMap = makeFloorMap([TerrainType.STONE_WALL], 1, 1);

    const result = buildTerrainLayer(scene, floorMap, { terrainPackId: 'industrial-cave' });

    // Wall stamp happens (wall texture is loaded), but underdraw is skipped (floor textures missing).
    expect(result.packWallCount).toBe(1);
    expect(result.packFloorCount).toBe(0);
    expect(rt.stamps).toHaveLength(1);
    expect(rt.stamps[0]!.key).toBe(pack.wallAutotile.textureKey);
  });
});

/**
 * Floor 1 biome terrain packs — proves `buildTerrainLayer` can texture a SINGLE
 * bake from TWO packs (masonry `floor1-dungeon` for STONE/CORRIDOR terrain,
 * organic `floor1-cave` for CAVE terrain) and that role-keyed special-room
 * floor pools win over the generic floor pool.
 *
 * Floor 1's generator (BiomeType.BASIC_UNDERGROUND) runs with
 * `caveRegions: true`, so a real Floor 1 map genuinely contains both terrain
 * families; a single per-floor `terrainPackId` cannot express it.
 *
 * Uses the REAL registered packs (the ones the floor manifest wires), not
 * synthetic fixtures, so this is the wiring contract and not a mock.
 */
import type Phaser from 'phaser';
import { describe, it, expect } from 'vitest';
import { buildTerrainLayer } from '../../src/engine/terrain-renderer.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import {
  BiomeType,
  RoomRole,
  TerrainType,
  TilePresets,
  type MapConfig,
  type RoomData,
} from '../../src/shared/map-types.js';
import { getTerrainPack } from '../../src/shared/terrain-pack-registry.js';
import { PIXELS_PER_FOOT } from '../../src/shared/units.js';
import { floor1Manifest } from '../../src/shared/floor-manifest.js';

interface StampCall {
  key: string;
  frame: number | undefined;
  x: number;
  y: number;
}

/**
 * Wall tiles are stamped twice: a floor-pool underdraw first (so the blob47
 * silhouette's transparent inset exposes ground, not black), then the wall
 * atlas. Assert on the atlas stamp by KEY rather than by index, or the
 * underdraw silently shifts every positional assertion by one.
 */
function stampsForKey(stamps: readonly StampCall[], key: string): StampCall[] {
  return stamps.filter((s) => s.key === key);
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
  readonly clears: { x: number; y: number; w: number; h: number }[] = [];

  clear(x: number, y: number, w: number, h: number): this {
    this.clears.push({ x, y, w, h });
    return this;
  }

  setOrigin(x: number, y: number): this {
    this.originX = x;
    this.originY = y;
    return this;
  }

  stamp(key: string, frame: number | undefined, x = 0, y = 0): this {
    this.stamps.push({ key, frame, x, y });
    return this;
  }

  fill(): this {
    return this;
  }

  render(): this {
    return this;
  }
}

function createPackScene(loadedKeys: ReadonlySet<string>): {
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

function makeFloorMap(
  terrainTypes: TerrainType[],
  widthTiles: number,
  heightTiles: number,
  rooms: RoomData[] = [],
): FloorMap {
  const config: MapConfig = {
    widthTiles,
    heightTiles,
    tileSizeFt: TILE_SIZE_FT,
    biome: BiomeType.BASIC_UNDERGROUND,
    seed: 42,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 0.5,
  };
  const tileMap = new TileMap(widthTiles, heightTiles);
  tileMap.fill(TilePresets.FLOOR);
  return new FloorMap(config, tileMap, new RoomGraph(rooms), Uint8Array.from(terrainTypes), {
    x: 0,
    y: 0,
  });
}

function makeRoom(role: RoomRole, x: number, y: number, width: number, height: number): RoomData {
  return { id: 0, bounds: { x, y, width, height }, doors: [], neighbors: [], role };
}

const dungeonPack = getTerrainPack('floor1-dungeon');
const cavePack = getTerrainPack('floor1-cave');

/** Simulates BootScene's preload completing for BOTH Floor 1 packs. */
const allKeys = new Set<string>([
  dungeonPack.wallAutotile.textureKey,
  cavePack.wallAutotile.textureKey,
  ...dungeonPack.floorPool.map((v) => v.textureKey),
  ...dungeonPack.corridorPool.map((v) => v.textureKey),
  ...cavePack.floorPool.map((v) => v.textureKey),
  ...Object.values(dungeonPack.specialFloorPools ?? {}).flatMap((pool) =>
    pool.map((v) => v.textureKey),
  ),
]);

const floor1Packs = { stone: 'floor1-dungeon', cave: 'floor1-cave' } as const;

describe('buildTerrainLayer — Floor 1 per-family pack assignment', () => {
  it('textures stone and cave walls from DIFFERENT pack atlases in one bake', () => {
    const { scene, rt } = createPackScene(allKeys);
    const floorMap = makeFloorMap([TerrainType.STONE_WALL, TerrainType.CAVE_WALL], 2, 1);

    const result = buildTerrainLayer(scene, floorMap, { terrainPacks: floor1Packs });

    expect(result.packWallCount).toBe(2);
    const keys = rt.stamps.map((s) => s.key);
    expect(keys).toContain(dungeonPack.wallAutotile.textureKey);
    expect(keys).toContain(cavePack.wallAutotile.textureKey);
  });

  it('keeps the wall SILHOUETTE continuous across a dungeon/cave seam', () => {
    // Both tiles see each other as "wall", so neither is classified isolated —
    // this is what stops a visible notch at a biome boundary.
    //
    // Both scenarios pad with real in-bounds FLOOR tiles rather than using a
    // bare 1x1/2x1 map: with the dynamic wall-inset fix, an out-of-bounds
    // neighbor now reads as wall/rock (for edge full-bleed), so a degenerate
    // map would make every neighbor of every wall tile read as wall
    // regardless of the seam under test, collapsing both cases to the same
    // (fully-enclosed) frame.
    const { scene, rt } = createPackScene(allKeys);
    const isolatedGrid = Array<TerrainType>(9).fill(TerrainType.STONE_FLOOR);
    isolatedGrid[4] = TerrainType.STONE_WALL; // center of 3x3, all-floor neighbors
    const isolated = makeFloorMap(isolatedGrid, 3, 3);
    const { scene: sceneB, rt: rtB } = createPackScene(allKeys);
    const adjacentGrid = Array<TerrainType>(12).fill(TerrainType.STONE_FLOOR);
    adjacentGrid[5] = TerrainType.STONE_WALL; // (1,1) of 4x3
    adjacentGrid[6] = TerrainType.CAVE_WALL; // (2,1) of 4x3
    const adjacent = makeFloorMap(adjacentGrid, 4, 3);

    buildTerrainLayer(scene, isolated, { terrainPacks: floor1Packs });
    buildTerrainLayer(sceneB, adjacent, { terrainPacks: floor1Packs });

    const isolatedFrame = stampsForKey(rt.stamps, dungeonPack.wallAutotile.textureKey)[0]?.frame;
    const seamFrame = stampsForKey(rtB.stamps, dungeonPack.wallAutotile.textureKey)[0]?.frame;
    expect(isolatedFrame).toBeDefined();
    expect(seamFrame).toBeDefined();
    expect(seamFrame).not.toBe(isolatedFrame);
  });

  it('routes cave floors to the cave pack and corridors to the masonry pack', () => {
    const { scene, rt } = createPackScene(allKeys);
    const floorMap = makeFloorMap([TerrainType.CAVE_FLOOR, TerrainType.CORRIDOR], 2, 1);

    const result = buildTerrainLayer(scene, floorMap, { terrainPacks: floor1Packs });

    expect(result.packFloorCount).toBe(1);
    expect(result.packCorridorCount).toBe(1);
    const caveKeys = new Set(cavePack.floorPool.map((v) => v.textureKey));
    const corridorKeys = new Set(dungeonPack.corridorPool.map((v) => v.textureKey));
    expect(rt.stamps.some((s) => caveKeys.has(s.key))).toBe(true);
    expect(rt.stamps.some((s) => corridorKeys.has(s.key))).toBe(true);
  });

  it('falls back to the single terrainPackId for a family with no override (Floor 2 path)', () => {
    const { scene, rt } = createPackScene(allKeys);
    const floorMap = makeFloorMap([TerrainType.CAVE_WALL], 1, 1);

    const result = buildTerrainLayer(scene, floorMap, { terrainPackId: 'floor1-cave' });

    expect(result.packWallCount).toBe(1);
    expect(stampsForKey(rt.stamps, cavePack.wallAutotile.textureKey)).toHaveLength(1);
  });

  it('renders the legacy path untouched when no pack is supplied', () => {
    const { scene } = createPackScene(allKeys);
    const floorMap = makeFloorMap([TerrainType.STONE_WALL, TerrainType.CAVE_FLOOR], 2, 1);

    const result = buildTerrainLayer(scene, floorMap, {});

    expect(result.packWallCount).toBe(0);
    expect(result.packFloorCount).toBe(0);
    expect(result.packSpecialFloorCount).toBe(0);
  });

  /**
   * A pack ships INERT unless `BootScene.preload()` loads its textures. This is
   * the failure this whole feature is most likely to regress into, and it is
   * silent: the renderer degrades to the legacy `TILE_VISUALS` path rather than
   * throwing, so nothing surfaces except art that quietly looks wrong.
   */
  it('degrades to the legacy path (not a crash) when pack textures never loaded', () => {
    const { scene, rt } = createPackScene(new Set<string>());
    const floorMap = makeFloorMap([TerrainType.STONE_WALL, TerrainType.CAVE_FLOOR], 2, 1);

    const result = buildTerrainLayer(scene, floorMap, { terrainPacks: floor1Packs });

    expect(result.packWallCount).toBe(0);
    expect(result.packFloorCount).toBe(0);
    expect(rt.stamps).toHaveLength(0);
    expect(result.spriteCount + result.colorCount).toBeGreaterThan(0);
  });

  /**
   * The mock records stamp coordinates specifically so this assertion can exist:
   * without it a regression that stamped every tile at (0,0) would keep all the
   * key-based assertions above green while rendering the entire floor in one
   * corner.
   */
  it('stamps each pack tile at its own tile coordinate, not a shared origin', () => {
    const { scene, rt } = createPackScene(allKeys);
    // A wall row over a floor row. The floor row matters: a wall is only
    // underdrawn when its blob47 frame has an open edge (an enclosed
    // mask-255 frame is opaque across the whole cell and needs no underdraw),
    // so an all-wall fixture would have no underdraw to locate.
    const floorMap = makeFloorMap(
      [
        TerrainType.STONE_WALL,
        TerrainType.STONE_WALL,
        TerrainType.STONE_FLOOR,
        TerrainType.STONE_FLOOR,
      ],
      2,
      2,
    );

    buildTerrainLayer(scene, floorMap, { terrainPacks: floor1Packs });

    const tileSize = TILE_SIZE_FT * PIXELS_PER_FOOT;
    const wallStamps = stampsForKey(rt.stamps, dungeonPack.wallAutotile.textureKey);
    expect(wallStamps).toHaveLength(2);

    // Wall atlas cells are origin-anchored at `tx * tileSize`...
    expect(wallStamps.map((s) => s.x)).toEqual([0, tileSize]);
    expect(wallStamps.map((s) => s.y)).toEqual([0, 0]);

    // ...while pool tiles (here the floor underdraw beneath each wall) are
    // centre-anchored at `tx * tileSize + tileSize / 2`. The two anchoring
    // conventions differ by exactly a half tile, which is what keeps the
    // underdraw registered to the same cell as the wall it sits beneath.
    const floorKeys = new Set(dungeonPack.floorPool.map((v) => v.textureKey));
    const underdraw = rt.stamps.filter((s) => floorKeys.has(s.key) && s.y < tileSize);
    expect(underdraw).toHaveLength(2);
    expect(underdraw.map((s) => s.x)).toEqual([tileSize / 2, tileSize + tileSize / 2]);
    expect(underdraw.map((s) => s.y)).toEqual([tileSize / 2, tileSize / 2]);
  });
});

describe('buildTerrainLayer — role-keyed special-room floor pools', () => {
  it('prefers the safe/boss-stair pools over the generic floor pool', () => {
    const { scene, rt } = createPackScene(allKeys);
    const floorMap = makeFloorMap(
      [TerrainType.SAFE_ROOM_FLOOR, TerrainType.BOSS_STAIR_FLOOR, TerrainType.STONE_FLOOR],
      3,
      1,
    );

    const result = buildTerrainLayer(scene, floorMap, { terrainPacks: floor1Packs });

    expect(result.packSpecialFloorCount).toBe(2);
    expect(result.packFloorCount).toBe(1);
    const safeKeys = new Set(dungeonPack.specialFloorPools?.safe?.map((v) => v.textureKey) ?? []);
    const bossKeys = new Set(
      dungeonPack.specialFloorPools?.bossStair?.map((v) => v.textureKey) ?? [],
    );
    expect(rt.stamps.some((s) => safeKeys.has(s.key))).toBe(true);
    expect(rt.stamps.some((s) => bossKeys.has(s.key))).toBe(true);
  });

  it('uses the welcome pool for plain STONE_FLOOR inside a SPAWN room only', () => {
    const { scene, rt } = createPackScene(allKeys);
    // Tile 0 is inside the spawn room; tile 1 is outside it.
    const floorMap = makeFloorMap([TerrainType.STONE_FLOOR, TerrainType.STONE_FLOOR], 2, 1, [
      makeRoom(RoomRole.SPAWN, 0, 0, 1, 1),
    ]);

    const result = buildTerrainLayer(scene, floorMap, { terrainPacks: floor1Packs });

    expect(result.packSpecialFloorCount).toBe(1);
    expect(result.packFloorCount).toBe(1);
    const welcomeKeys = new Set(
      dungeonPack.specialFloorPools?.welcome?.map((v) => v.textureKey) ?? [],
    );
    const welcomeStamps = rt.stamps.filter((s) => welcomeKeys.has(s.key));
    expect(welcomeStamps).toHaveLength(1);
    expect(rt.stamps.filter((s) => !welcomeKeys.has(s.key))).toHaveLength(1);
  });

  it('leaves STONE_FLOOR on the generic pool when the floor has no SPAWN room', () => {
    const { scene } = createPackScene(allKeys);
    const floorMap = makeFloorMap([TerrainType.STONE_FLOOR], 1, 1);

    const result = buildTerrainLayer(scene, floorMap, { terrainPacks: floor1Packs });

    expect(result.packSpecialFloorCount).toBe(0);
    expect(result.packFloorCount).toBe(1);
  });
});

describe('floor1 manifest — terrain pack wiring', () => {
  it('assigns both Floor 1 packs and still omits the single-pack terrainPackId', () => {
    const manifest = floor1Manifest;
    expect(manifest?.terrainPackId).toBeUndefined();
    expect(manifest?.terrainPacks).toEqual({ stone: 'floor1-dungeon', cave: 'floor1-cave' });
  });
});

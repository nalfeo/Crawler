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
import {
  buildTerrainLayer,
  PACK_WALL_MASK_NEIGHBOR_TERRAIN_TYPES,
} from '../../src/engine/terrain-renderer.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import {
  BiomeType,
  RoomRole,
  TerrainType,
  TilePresets,
  type MapConfig,
} from '../../src/shared/map-types.js';
import { PIXELS_PER_FOOT } from '../../src/shared/units.js';
import { getTerrainPack } from '../../src/shared/terrain-pack-registry.js';
import {
  _computeRawMask8,
  MASK_BIT,
  neighborMask8InTerrain,
  normalizeBlob47Mask,
} from '../../src/shared/terrain-pack-mask.js';
import {
  pickPoolCombo,
  buildPoolStampConfig,
  pickWallAccentSelection,
} from '../../src/shared/terrain-pack-variants.js';

interface StampCall {
  key: string;
  frame: number | undefined;
  x: number;
  y: number;
  config: { originX: number; originY: number; scaleX: number; scaleY: number; rotation?: number };
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
  readonly clears: { x: number; y: number; w: number; h: number }[] = [];

  setOrigin(x: number, y: number): this {
    this.originX = x;
    this.originY = y;
    return this;
  }

  clear(x: number, y: number, w: number, h: number): this {
    this.clears.push({ x, y, w, h });
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
  roomGraph: RoomGraph = new RoomGraph(),
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
  return new FloorMap(config, tileMap, roomGraph, terrain, { x: 0, y: 0 });
}

function makeLineworkFloorMap(seed = 4242): FloorMap {
  const size = 25;
  const terrain = Array<TerrainType>(size * size).fill(TerrainType.STONE_WALL);
  const carve = (tx: number, ty: number, radius = 0): void => {
    for (let y = ty - radius; y <= ty + radius; y++) {
      for (let x = tx - radius; x <= tx + radius; x++) {
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        terrain[y * size + x] = TerrainType.STONE_FLOOR;
      }
    }
  };
  for (let tx = 2; tx < size - 2; tx++) carve(tx, 12);
  for (let ty = 2; ty < size - 2; ty++) carve(12, ty);
  for (let tx = 4; tx < size - 4; tx++) carve(tx, 6);
  for (let tx = 4; tx < size - 4; tx++) carve(tx, 18);
  for (let ty = 4; ty < size - 4; ty++) carve(6, ty);
  for (let ty = 4; ty < size - 4; ty++) carve(18, ty);
  carve(6, 6, 1);
  carve(18, 18, 1);

  const roomGraph = new RoomGraph();
  roomGraph.add({ x: 5, y: 5, width: 3, height: 3 }, [], [], RoomRole.BOSS_DEN);
  roomGraph.add({ x: 17, y: 17, width: 3, height: 3 }, [], [], RoomRole.RESOURCE_HEART);
  return makeFloorMap(terrain, size, size, seed, roomGraph);
}

const pack = getTerrainPack('industrial-cave');

/** Atlas frameIndex the pack assigns to a given canonical blob47 mask. */
function maskFrameIndex(maskId: number): number {
  const entry = pack.wallAutotile.masks.find((m) => m.maskId === maskId);
  if (!entry) throw new Error(`pack has no frame for mask ${maskId}`);
  return entry.frameIndex;
}

/** Terrain types the pack stamps from the wall atlas (i.e. cover cells). */
function isPackWall(terrain: TerrainType): boolean {
  return terrain === TerrainType.STONE_WALL || terrain === TerrainType.CAVE_WALL;
}
const packWallScale = tileSize / pack.wallAutotile.cellPx;
const packPoolScale = tileSize / 64;

/** All texture keys that the industrial-cave pack uses — simulates the BootScene preload completing. */
const allPackKeys = new Set<string>([
  pack.wallAutotile.textureKey,
  ...pack.floorPool.map((v) => v.textureKey),
  ...pack.corridorPool.map((v) => v.textureKey),
  ...(pack.wallAccents ?? []).map((a) => a.textureKey),
  ...(pack.linework ?? []).map((l) => l.textureKey),
  ...(pack.linework ?? []).flatMap((l) => (l.props ? [l.props.textureKey] : [])),
]);

describe('buildTerrainLayer — terrain-pack atlas frame stamping (refinement #8)', () => {
  it('bypasses generated/sprite/color entirely for an isolated STONE_WALL tile', () => {
    const { scene, rt } = createPackScene(allPackKeys);
    // 3x3 grid, STONE_WALL at the center surrounded by real in-bounds FLOOR
    // tiles on all 8 sides. A degenerate 1x1 map would put every neighbor
    // out-of-bounds, which the wall mask now (correctly) reads as wall/rock
    // for full-bleed edge behavior — that would test the fully-enclosed case,
    // not an isolated wall, so the center tile needs genuine floor neighbors.
    const grid = Array<TerrainType>(9).fill(TerrainType.STONE_FLOOR);
    grid[4] = TerrainType.STONE_WALL; // center, index (1,1) in a 3x3 grid
    const floorMap = makeFloorMap(grid, 3, 3);

    const result = buildTerrainLayer(scene, floorMap, { terrainPackId: 'industrial-cave' });

    expect(result.generatedCount).toBe(0);
    expect(result.spriteCount).toBe(0);
    expect(result.colorCount).toBe(0);
    expect(result.packWallCount).toBe(1);
    expect(result.packFloorCount).toBe(8);
    expect(result.packCorridorCount).toBe(0);

    // Isolated wall: no wall neighbors -> raw mask 0 -> canonical mask 0.
    const expectedMask = normalizeBlob47Mask(0);
    const expectedFrame = pack.wallAutotile.masks.find(
      (m) => m.maskId === expectedMask,
    )!.frameIndex;

    const baseWallStamps = rt.stamps.filter((s) => s.key === pack.wallAutotile.textureKey);
    expect(baseWallStamps).toHaveLength(1);
    expect(baseWallStamps[0]!.frame).toBe(expectedFrame);
    expect(baseWallStamps[0]!.config.scaleX).toBe(packWallScale);
    expect(baseWallStamps[0]!.config.scaleY).toBe(packWallScale);
    const accentKeys = new Set((pack.wallAccents ?? []).map((a) => a.textureKey));
    const accentStamps = rt.stamps.filter((s) => accentKeys.has(s.key));
    for (const accentStamp of accentStamps) {
      expect(accentStamp.frame).toBe(expectedFrame);
    }
  });

  it('stamps the fully-enclosed (mask 255) frame for an interior wall tile surrounded by walls', () => {
    const { scene, rt } = createPackScene(allPackKeys);
    // 3x3 all-wall grid: the center tile has all 8 neighbors as walls.
    const grid = Array<TerrainType>(9).fill(TerrainType.STONE_WALL);
    const floorMap = makeFloorMap(grid, 3, 3);

    buildTerrainLayer(scene, floorMap, { terrainPackId: 'industrial-cave' });

    // Base wall stamps only (accent stamps interleave optionally, so filter
    // by textureKey rather than a fixed positional index). Center tile is
    // index (1,1) -> the 5th base wall stamp (row-major, ty then tx).
    const baseWallStamps = rt.stamps.filter((s) => s.key === pack.wallAutotile.textureKey);
    expect(baseWallStamps).toHaveLength(9);
    const centerStamp = baseWallStamps[1 * 3 + 1];
    const rawMask = neighborMask8InTerrain(floorMap.terrain, 3, 3, 1, 1, TerrainType.STONE_WALL);
    expect(rawMask).toBe(255);
    const canonicalMask = normalizeBlob47Mask(255);
    const expectedFrame = pack.wallAutotile.masks.find(
      (m) => m.maskId === canonicalMask,
    )!.frameIndex;

    expect(centerStamp!.key).toBe(pack.wallAutotile.textureKey);
    expect(centerStamp!.frame).toBe(expectedFrame);
  });

  it.each(['floor1-dungeon', 'industrial-cave'] as const)(
    'treats a DOOR neighbour as wall so %s walls run flush into the jamb',
    (packId) => {
      // The defect: a door is a hole in a wall line, and its own art is a
      // full-bleed tile. When the blob47 mask read DOOR as floor, each flanking
      // wall picked mask 0 (isolated), which insets `WALL_INSET_PX` off every
      // side — leaving a visible strip of floor between the wall and the door
      // jamb. The wall must instead select the mask with the door's cardinal bit
      // set, whose silhouette reaches that shared boundary. Covered for BOTH the
      // square dungeon pack this session regenerated and a rounded cave pack, so
      // the rule is proven to be a terrain semantic rather than dungeon-only.
      const doorPack = getTerrainPack(packId);
      const keys = new Set<string>([
        doorPack.wallAutotile.textureKey,
        ...doorPack.floorPool.map((v) => v.textureKey),
        ...doorPack.corridorPool.map((v) => v.textureKey),
        ...(doorPack.wallAccents ?? []).map((a) => a.textureKey),
        ...(doorPack.linework ?? []).map((l) => l.textureKey),
      ]);
      const { scene, rt } = createPackScene(keys);
      // 5x3 grid: middle row is [FLOOR, WALL, DOOR, WALL, FLOOR], flanked
      // above/below by FLOOR rows. This keeps every neighbor of both wall
      // tiles in-bounds — a bare 3x1 row would put N/S (and, for the
      // outermost walls, W/E too) out-of-bounds, which the wall mask now
      // (correctly) reads as wall/rock for edge full-bleed, swamping the
      // door-neighbour signal this test targets.
      const grid = Array<TerrainType>(15).fill(TerrainType.STONE_FLOOR);
      grid[6] = TerrainType.STONE_WALL; // (1,1)
      grid[7] = TerrainType.DOOR; // (2,1)
      grid[8] = TerrainType.STONE_WALL; // (3,1)
      const floorMap = makeFloorMap(grid, 5, 3);

      buildTerrainLayer(scene, floorMap, { terrainPackId: packId });

      const baseWallStamps = rt.stamps.filter((s) => s.key === doorPack.wallAutotile.textureKey);
      // The door tile itself is NOT stamped from the wall atlas — this is a
      // neighbour-only rule.
      expect(baseWallStamps).toHaveLength(2);

      const frameFor = (rawMask: number) =>
        doorPack.wallAutotile.masks.find((m) => m.maskId === normalizeBlob47Mask(rawMask))!
          .frameIndex;
      const isolatedFrame = frameFor(0);
      // Left wall connects EAST to the door; right wall connects WEST.
      const eastFrame = frameFor(MASK_BIT.E);
      const westFrame = frameFor(MASK_BIT.W);

      expect(baseWallStamps[0]!.frame).toBe(eastFrame);
      expect(baseWallStamps[1]!.frame).toBe(westFrame);
      // Guards against the assertion passing vacuously if the pack ever collapsed
      // those masks onto one frame.
      expect(eastFrame).not.toBe(isolatedFrame);
      expect(westFrame).not.toBe(isolatedFrame);
    },
  );

  it('HARD GATE: treats a VOID (rock) neighbour as wall so no floor apron leaks past a wall into rock', () => {
    // The defect: the mask predicate treated ANY non-wall neighbour (including
    // solid rock, TerrainType.VOID) as "absent", so a wall bordering rock
    // inset away from it and exposed a sliver of room floor sitting inside the
    // rock. The fix: PACK_WALL_MASK_NEIGHBOR_TERRAIN_TYPES now includes VOID,
    // so a wall reads rock as wall for mask purposes and full-bleeds against
    // it — no floor-pool apron underneath.
    const { scene, rt } = createPackScene(allPackKeys);
    // 3x3 grid, STONE_WALL at center; every neighbour is real in-bounds FLOOR
    // *except* the north neighbour, which is VOID (solid rock). Every other
    // neighbour stays FLOOR so only the VOID signal is under test.
    const grid = Array<TerrainType>(9).fill(TerrainType.STONE_FLOOR);
    grid[1] = TerrainType.VOID; // (1,0) — north of center
    grid[4] = TerrainType.STONE_WALL; // (1,1) — center, tile under test
    const floorMap = makeFloorMap(grid, 3, 3);

    buildTerrainLayer(scene, floorMap, { terrainPackId: 'industrial-cave' });

    const wallStamps = rt.stamps.filter((s) => s.key === pack.wallAutotile.textureKey);
    expect(wallStamps).toHaveLength(1);

    const frameFor = (rawMask: number) =>
      pack.wallAutotile.masks.find((m) => m.maskId === normalizeBlob47Mask(rawMask))!.frameIndex;
    const isolatedFrame = frameFor(0);
    const northFrame = frameFor(MASK_BIT.N);

    // The wall must select the mask with its NORTH cardinal bit set (rock read
    // as wall), not the isolated (mask 0, all-sides-inset) frame.
    expect(wallStamps[0]!.frame).toBe(northFrame);
    expect(northFrame).not.toBe(isolatedFrame);

    // And the floor pool must NOT stamp anything into the rock tile itself —
    // VOID is not a poolable terrain type, so no apron slips out past the wall.
    const poolKeys = new Set<string>([
      ...pack.floorPool.map((v) => v.textureKey),
      ...pack.corridorPool.map((v) => v.textureKey),
    ]);
    const voidTileCenterX = 1 * tileSize + tileSize / 2;
    const voidTileCenterY = 0 * tileSize + tileSize / 2;
    const poolStampsAtVoidTile = rt.stamps.filter(
      (s) => poolKeys.has(s.key) && s.x === voidTileCenterX && s.y === voidTileCenterY,
    );
    expect(poolStampsAtVoidTile).toHaveLength(0);
  });

  it('HARD GATE: treats a TREE neighbour as wall so no floor apron leaks past a wall into a tree', () => {
    // Same defect class as the VOID gate above, and this exact membership has
    // already been dropped once (and shipped green) on the theory that TREE has
    // no wall art. That theory is irrelevant: this is a NEIGHBOUR-ONLY rule, so
    // including TREE never stamps the wall atlas into the tree tile — it only
    // stops the wall from insetting away from a tile you cannot walk onto and
    // exposing a floor sliver under the tree. The maintainer's rule is "do not
    // inset on sides where the other side is not walkable"; TREE is not
    // walkable, so it belongs in the set.
    const { scene, rt } = createPackScene(allPackKeys);
    // 3x3 grid, STONE_WALL at center; every neighbour is real in-bounds FLOOR
    // *except* the north neighbour, which is TREE. Only the TREE signal is
    // under test.
    const grid = Array<TerrainType>(9).fill(TerrainType.STONE_FLOOR);
    grid[1] = TerrainType.TREE; // (1,0) — north of center
    grid[4] = TerrainType.STONE_WALL; // (1,1) — center, tile under test
    const floorMap = makeFloorMap(grid, 3, 3);

    buildTerrainLayer(scene, floorMap, { terrainPackId: 'industrial-cave' });

    const wallStamps = rt.stamps.filter((s) => s.key === pack.wallAutotile.textureKey);
    expect(wallStamps).toHaveLength(1);

    const frameFor = (rawMask: number) =>
      pack.wallAutotile.masks.find((m) => m.maskId === normalizeBlob47Mask(rawMask))!.frameIndex;
    const isolatedFrame = frameFor(0);
    const northFrame = frameFor(MASK_BIT.N);

    // The wall must select the mask with its NORTH cardinal bit set (tree read
    // as solid), not the isolated (mask 0, all-sides-inset) frame.
    expect(wallStamps[0]!.frame).toBe(northFrame);
    expect(northFrame).not.toBe(isolatedFrame);
  });

  it('HARD GATE: every non-walkable neighbour terrain type stays in the wall-mask set', () => {
    // Direct set-membership backstop for the behavioural gates above. The
    // behavioural tests only cover VOID and TREE; this catches a silent drop of
    // any member of the rule, including WOOD_WALL and DOOR, which have no
    // dedicated mask gate of their own.
    for (const terrain of [
      TerrainType.DOOR,
      TerrainType.VOID,
      TerrainType.WOOD_WALL,
      TerrainType.TREE,
    ]) {
      expect(PACK_WALL_MASK_NEIGHBOR_TERRAIN_TYPES.has(terrain)).toBe(true);
    }
  });

  it('HARD GATE: treats an out-of-bounds neighbour as wall so a map-edge wall full-bleeds instead of insetting into nothing', () => {
    // The defect: `computeRawMask8` treated OOB neighbours as non-matching
    // (floor) by default, so a wall on the map edge insets away from the edge
    // exactly as if bordered by real floor — exposing a floor-pool sliver past
    // the map's border. The fix: the pack wall-mask call sites now pass
    // `outOfBoundsMatches = true`, so a missing neighbour past the border
    // reads as wall/rock, matching the in-bounds VOID rule above.
    const { scene, rt } = createPackScene(allPackKeys);
    // 3x3 grid, STONE_WALL at the WEST edge, middle row: (0,1). Its west
    // neighbour (x=-1) is out-of-bounds; every other neighbour is real
    // in-bounds FLOOR, so only the OOB signal is under test.
    const grid = Array<TerrainType>(9).fill(TerrainType.STONE_FLOOR);
    grid[3] = TerrainType.STONE_WALL; // (0,1) — west edge, tile under test
    const floorMap = makeFloorMap(grid, 3, 3);

    buildTerrainLayer(scene, floorMap, { terrainPackId: 'industrial-cave' });

    const wallStamps = rt.stamps.filter((s) => s.key === pack.wallAutotile.textureKey);
    expect(wallStamps).toHaveLength(1);

    const frameFor = (rawMask: number) =>
      pack.wallAutotile.masks.find((m) => m.maskId === normalizeBlob47Mask(rawMask))!.frameIndex;
    const isolatedFrame = frameFor(0);
    const westFrame = frameFor(MASK_BIT.W);

    // The wall must select the mask with its WEST cardinal bit set (map edge
    // read as wall), not the isolated (mask 0, all-sides-inset) frame.
    expect(wallStamps[0]!.frame).toBe(westFrame);
    expect(westFrame).not.toBe(isolatedFrame);
  });

  it('treats STONE_WALL and CAVE_WALL as connected pack walls for mask selection', () => {
    const { scene, rt } = createPackScene(allPackKeys);
    // 4x3 grid: middle row is [FLOOR, STONE_WALL, CAVE_WALL, FLOOR], flanked
    // above/below by FLOOR rows, so neither wall tile has an out-of-bounds
    // neighbor — a bare 2x1 row would put nearly every neighbor OOB, which
    // the wall mask now (correctly) reads as wall/rock, swamping the signal
    // this test targets (STONE_WALL/CAVE_WALL reading each other as wall).
    const grid = Array<TerrainType>(12).fill(TerrainType.STONE_FLOOR);
    grid[5] = TerrainType.STONE_WALL; // (1,1)
    grid[6] = TerrainType.CAVE_WALL; // (2,1)
    const floorMap = makeFloorMap(grid, 4, 3);

    buildTerrainLayer(scene, floorMap, { terrainPackId: 'industrial-cave' });

    const isWallLike = (nx: number, ny: number): boolean => {
      const t = floorMap.terrain[ny * 4 + nx] as TerrainType;
      return t === TerrainType.STONE_WALL || t === TerrainType.CAVE_WALL;
    };
    const rawLeft = _computeRawMask8(1, 1, 4, 3, isWallLike);
    const rawRight = _computeRawMask8(2, 1, 4, 3, isWallLike);
    const leftFrame = pack.wallAutotile.masks.find(
      (m) => m.maskId === normalizeBlob47Mask(rawLeft),
    )!.frameIndex;
    const rightFrame = pack.wallAutotile.masks.find(
      (m) => m.maskId === normalizeBlob47Mask(rawRight),
    )!.frameIndex;

    // Base wall stamps only — accent stamps (if any) interleave optionally.
    const baseWallStamps = rt.stamps.filter((s) => s.key === pack.wallAutotile.textureKey);
    expect(baseWallStamps).toHaveLength(2);
    expect(baseWallStamps[0]!.frame).toBe(leftFrame);
    expect(baseWallStamps[1]!.frame).toBe(rightFrame);
    expect(baseWallStamps[0]!.frame).not.toBe(
      pack.wallAutotile.masks.find((m) => m.maskId === 0)!.frameIndex,
    );
    expect(baseWallStamps[1]!.frame).not.toBe(
      pack.wallAutotile.masks.find((m) => m.maskId === 0)!.frameIndex,
    );
  });
  it('stamps a deterministic floorPool combo (center-origin, transform-aware) for STONE_FLOOR tiles', () => {
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
      const expectedCombo = pickPoolCombo(pack.floorPool, 7, tx, 0)!;
      const expectedConfig = buildPoolStampConfig(expectedCombo.transform, packPoolScale);
      expect(rt.stamps[tx]!.key).toBe(expectedCombo.variant.textureKey);
      expect(rt.stamps[tx]!.frame).toBeUndefined();
      expect(rt.stamps[tx]!.x).toBe(tx * tileSize + tileSize / 2);
      expect(rt.stamps[tx]!.y).toBe(tileSize / 2);
      expect(rt.stamps[tx]!.config).toEqual(expectedConfig);
    }

    // Live diversity instrumentation (refinement #4): every stamped tile's
    // source id and transform are tallied.
    const totalFloorSourceCount = Object.values(result.packFloorSourceCounts).reduce(
      (a, b) => a + b,
      0,
    );
    const totalFloorTransformCount = Object.values(result.packFloorTransformCounts).reduce(
      (a, b) => a + b,
      0,
    );
    const totalFloorComboCount = Object.values(result.packFloorComboCounts).reduce(
      (a, b) => a + b,
      0,
    );
    expect(totalFloorSourceCount).toBe(3);
    expect(totalFloorTransformCount).toBe(3);
    expect(totalFloorComboCount).toBe(3);
  });

  it('stamps a deterministic corridorPool combo for CORRIDOR tiles (API completeness — not exercised by Floor 2 gameplay today)', () => {
    const { scene, rt } = createPackScene(allPackKeys);
    const floorMap = makeFloorMap([TerrainType.CORRIDOR, TerrainType.CORRIDOR], 2, 1, 11);

    const result = buildTerrainLayer(scene, floorMap, { terrainPackId: 'industrial-cave' });

    expect(result.packCorridorCount).toBe(2);
    for (let tx = 0; tx < 2; tx++) {
      const expectedCombo = pickPoolCombo(pack.corridorPool, 11, tx, 0)!;
      expect(rt.stamps[tx]!.key).toBe(expectedCombo.variant.textureKey);
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

  it('can assign a pack to cave terrain without changing the stone fallback path', () => {
    const { scene, rt } = createPackScene(allPackKeys);
    const floorMap = makeFloorMap([TerrainType.STONE_FLOOR, TerrainType.CAVE_FLOOR], 2, 1);

    const result = buildTerrainLayer(scene, floorMap, {
      terrainPacks: { cave: 'industrial-cave' },
    });

    expect(result.packFloorCount).toBe(1);
    expect(rt.stamps).toHaveLength(1);
    expect(pack.floorPool.some((variant) => variant.textureKey === rt.stamps[0]!.key)).toBe(true);
    expect(result.colorCount).toBe(1);
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

  it('accented wall tiles add a SECOND stamp (same frame, accent texture) on top of the base wall stamp (2026-07-25 refinement #3/#6)', () => {
    const { scene, rt } = createPackScene(allPackKeys);
    // A reasonably large all-wall grid gives the deterministic accent picker
    // enough tiles to guarantee at least one accented tile at this seed.
    const size = 30;
    const grid = Array<TerrainType>(size * size).fill(TerrainType.STONE_WALL);
    const floorMap = makeFloorMap(grid, size, size, 321);

    const result = buildTerrainLayer(scene, floorMap, { terrainPackId: 'industrial-cave' });

    expect(result.packWallCount).toBe(size * size);
    expect(result.packWallAccentedCount).toBeGreaterThan(0);
    // Structural performance cap (refinement #6): accent stamps are strictly
    // a SECOND stamp on already-stamped wall tiles, never their own tile —
    // so accented count can never exceed total wall count.
    expect(result.packWallAccentedCount).toBeLessThanOrEqual(result.packWallCount);
    const totalAccentCounts = Object.values(result.packWallAccentCounts).reduce((a, b) => a + b, 0);
    expect(totalAccentCounts).toBe(result.packWallAccentedCount);

    // Reconstruct the EXACT expected stamp sequence from the pure picker and
    // assert the mock RenderTexture recorded exactly that sequence — proves
    // the accent stamp reuses the SAME frameIndex as its tile's base wall
    // stamp (mask-aware sharing, refinement #3) and comes immediately after
    // it (one extra stamp per accented tile, never its own tile).
    // A wall tile gets a floorPool underdraw only when its blob47 frame has
    // an open edge, because only an open edge carries a transparent inset
    // quadrant for the underdraw to show through. In this fully enclosed
    // all-wall grid every tile normalizes to mask 255, so none of them are
    // underdrawn at all.
    const isWallLike = (nx: number, ny: number): boolean =>
      floorMap.terrain[ny * size + nx] === TerrainType.STONE_WALL;
    let expectedStampCount = 0;
    let cursor = 0;
    for (let ty = 0; ty < size; ty++) {
      for (let tx = 0; tx < size; tx++) {
        const mask = normalizeBlob47Mask(_computeRawMask8(tx, ty, size, size, isWallLike, true));
        expect(mask).toBe(255);
        if (mask !== 255) {
          cursor += 1; // skip underdraw stamp
          expectedStampCount += 1;
        }
        expectedStampCount += 1; // wall stamp
        const wallStamp = rt.stamps[cursor]!;
        expect(wallStamp.key).toBe(pack.wallAutotile.textureKey);
        cursor += 1;
        const accent = pickWallAccentSelection(
          pack.wallAccents ?? [],
          floorMap.config.seed,
          tx,
          ty,
        );
        if (accent) {
          expectedStampCount += 1;
          const accentStamp = rt.stamps[cursor]!;
          expect(accentStamp.key).toBe(accent.textureKey);
          expect(accentStamp.frame).toBe(wallStamp.frame);
          expect(accentStamp.config.scaleX).toBe(packWallScale);
          expect(accentStamp.config.scaleY).toBe(packWallScale);
          cursor += 1;
        }
      }
    }
    expect(rt.stamps).toHaveLength(expectedStampCount);
    // Every tile here is enclosed (mask 255), so the bake emits exactly one
    // wall stamp per tile plus one stamp per accented tile — and zero
    // underdraws, which is the whole point of the mask-255 skip.
    expect(expectedStampCount).toBe(size * size + result.packWallAccentedCount);
  });

  it('wall underdraw is deterministic: same seed+position gives same underdraw tile', () => {
    const { scene: sceneA, rt: rtA } = createPackScene(allPackKeys);
    const { scene: sceneB, rt: rtB } = createPackScene(allPackKeys);
    const floorMap = makeFloorMap([TerrainType.STONE_WALL], 1, 1, 77);

    buildTerrainLayer(sceneA, floorMap, { terrainPackId: 'industrial-cave' });
    buildTerrainLayer(sceneB, floorMap, { terrainPackId: 'industrial-cave' });

    // stamps[0] is the floor underdraw — must be identical across two bakes.
    expect(rtA.stamps[0]!.key).toBe(rtB.stamps[0]!.key);
    expect(rtA.stamps[0]!.config).toEqual(rtB.stamps[0]!.config);
  });

  it('wall stamps only wall frame (no underdraw) when floor pool textures are missing', () => {
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

  it('executes linework runtime stamping with props and deferred wall-entry ordering', () => {
    const { scene, rt } = createPackScene(allPackKeys);
    const floorMap = makeLineworkFloorMap(4242);

    const result = buildTerrainLayer(scene, floorMap, { terrainPackId: 'industrial-cave' });

    expect(result.packLineworkHubs).toHaveLength(2);
    expect(result.packLineworkTileCount).toBeGreaterThan(0);
    expect(result.packLineworkRuns.length).toBeGreaterThan(0);

    const lineworkKeys = new Set((pack.linework ?? []).map((layer) => layer.textureKey));
    const lineworkStamps = rt.stamps.filter((stamp) => lineworkKeys.has(stamp.key));
    expect(lineworkStamps.length).toBeGreaterThan(0);
    expect(lineworkStamps.some((stamp) => typeof stamp.frame === 'number')).toBe(true);

    const propKeys = new Set(
      (pack.linework ?? []).flatMap((layer) => (layer.props ? [layer.props.textureKey] : [])),
    );
    const propStamps = rt.stamps.filter((stamp) => propKeys.has(stamp.key));
    expect(propStamps.length).toBeGreaterThan(0);
    expect(propStamps.some((stamp) => stamp.config.rotation === Math.PI / 2)).toBe(true);

    const lastWallStampIndex = rt.stamps.reduce(
      (latest, stamp, index) => (stamp.key === pack.wallAutotile.textureKey ? index : latest),
      -1,
    );
    expect(lastWallStampIndex).toBeGreaterThanOrEqual(0);
    const deferredLineworkIndex = rt.stamps.findIndex(
      (stamp, index) => lineworkKeys.has(stamp.key) && index > lastWallStampIndex,
    );
    expect(deferredLineworkIndex).toBeGreaterThan(lastWallStampIndex);
  });
});

describe('buildTerrainLayer — ground decals are clipped by walls, not excluded by them', () => {
  const decalSets = pack.groundDecals ?? [];
  const decalKeys = new Set(decalSets.map((d) => d.textureKey));
  /** Pack keys plus the decal atlases, simulating a full BootScene preload. */
  const keysWithDecals = new Set<string>([...allPackKeys, ...decalKeys]);

  /** Open floor room ringed by one tile of wall. */
  function makeWalledRoom(size: number, seed: number): FloorMap {
    const grid = Array<TerrainType>(size * size).fill(TerrainType.CAVE_FLOOR);
    for (let ty = 0; ty < size; ty++) {
      for (let tx = 0; tx < size; tx++) {
        if (tx === 0 || ty === 0 || tx === size - 1 || ty === size - 1) {
          grid[ty * size + tx] = TerrainType.CAVE_WALL;
        }
      }
    }
    return makeFloorMap(grid, size, size, seed);
  }

  it('places decals whose footprint overhangs a wall (the old rule reserved a dead margin)', () => {
    expect(decalSets.length).toBeGreaterThan(0);
    const size = 40;
    const { scene, rt } = createPackScene(keysWithDecals);
    const floorMap = makeWalledRoom(size, 1234);

    const result = buildTerrainLayer(scene, floorMap, { terrainPackId: 'industrial-cave' });

    expect(result.packGroundDecalCount).toBeGreaterThan(0);

    // At least one decal must overhang the wall ring. Under the previous
    // all-or-nothing footprint rule this was impossible by construction.
    const overhanging = rt.stamps.filter((s) => {
      const set = decalSets.find((d) => d.textureKey === s.key);
      if (!set) return false;
      const half = (tileSize * set.spanTiles) / 2;
      return (
        s.x - half < tileSize ||
        s.y - half < tileSize ||
        s.x + half > (size - 1) * tileSize ||
        s.y + half > (size - 1) * tileSize
      );
    });
    expect(overhanging.length).toBeGreaterThan(0);
  });

  it('paints every wall tile AFTER all decals, clearing its cell first so the wall art is the mask', () => {
    const size = 40;
    const { scene, rt } = createPackScene(keysWithDecals);
    const floorMap = makeWalledRoom(size, 4321);

    const result = buildTerrainLayer(scene, floorMap, { terrainPackId: 'industrial-cave' });

    const lastDecalIndex = rt.stamps.reduce((acc, s, i) => (decalKeys.has(s.key) ? i : acc), -1);
    expect(lastDecalIndex).toBeGreaterThanOrEqual(0);
    const firstWallIndex = rt.stamps.findIndex((s) => s.key === pack.wallAutotile.textureKey);
    expect(firstWallIndex).toBeGreaterThan(lastDecalIndex);

    // The invariant is that decal overhang can never survive inside a wall
    // cell. The bake satisfies it one of two ways per cover cell: either it
    // clears the cell, or the cell ends in a repaint that is opaque across
    // the full cell (a mask-255 wall frame, or a floorPool underdraw beneath
    // an inset frame). Assert the invariant itself rather than the clear,
    // so the perf work — which replaced most clears with the observation
    // that an opaque repaint already destroys the ink — is still gated.
    const clearedCells = new Set(rt.clears.map((c) => `${c.x / tileSize},${c.y / tileSize}`));
    for (const c of rt.clears) {
      expect(c.w).toBe(tileSize);
      expect(c.h).toBe(tileSize);
    }
    const poolKeys = new Set(
      [...pack.floorPool, ...pack.corridorPool].map((variant) => variant.textureKey),
    );
    const cellOf = (s: StampCall): string =>
      `${Math.floor(s.x / tileSize)},${Math.floor(s.y / tileSize)}`;
    const opaqueRepainted = new Set(
      rt.stamps
        .filter(
          (s) =>
            poolKeys.has(s.key) ||
            (s.key === pack.wallAutotile.textureKey && s.frame === maskFrameIndex(255)),
        )
        .map(cellOf),
    );

    let coverCells = 0;
    for (let ty = 0; ty < size; ty++) {
      for (let tx = 0; tx < size; tx++) {
        if (!isPackWall(floorMap.terrain[ty * size + tx]!)) continue;
        coverCells += 1;
        const cell = `${tx},${ty}`;
        expect(clearedCells.has(cell) || opaqueRepainted.has(cell)).toBe(true);
      }
    }
    expect(coverCells).toBe(result.packWallCount);
  });

  it('rejects a large decal set inside a one-tile corridor (ground-fraction floor)', () => {
    const size = 40;
    const { scene, rt } = createPackScene(keysWithDecals);
    // A single horizontal one-tile-wide corridor through solid wall.
    const grid = Array<TerrainType>(size * size).fill(TerrainType.CAVE_WALL);
    const midY = Math.floor(size / 2);
    for (let tx = 0; tx < size; tx++) grid[midY * size + tx] = TerrainType.CORRIDOR;
    const floorMap = makeFloorMap(grid, size, size, 777);

    buildTerrainLayer(scene, floorMap, { terrainPackId: 'industrial-cave' });

    const largest = decalSets.reduce((a, b) => (a.spanTiles >= b.spanTiles ? a : b));
    expect(largest.spanTiles).toBeGreaterThanOrEqual(4);
    // A >=4-tile decal in a 1-tile corridor is <=25% ground, below the 0.35 floor.
    expect(rt.stamps.some((s) => s.key === largest.textureKey)).toBe(false);
  });

  it('does not stamp a pack\u2019s decals onto another family\u2019s ground (mixed-biome floors)', () => {
    const size = 40;
    // Cave-only room. Assigning the pack to the STONE family means nothing on
    // this map belongs to it, so it must contribute no decals — the previous
    // `anyPack` resolution stamped stone cracks all over cave ground (and
    // silently dropped the cave pack's own decals) on a two-pack floor.
    const stoneOnly = createPackScene(keysWithDecals);
    const stoneResult = buildTerrainLayer(stoneOnly.scene, makeWalledRoom(size, 2468), {
      terrainPacks: { stone: 'industrial-cave' },
    });
    expect(stoneResult.packGroundDecalCount).toBe(0);
    expect(stoneOnly.rt.stamps.some((s) => decalKeys.has(s.key))).toBe(false);

    // Control: the SAME map with the pack bound to the cave family does decal.
    const caveOnly = createPackScene(keysWithDecals);
    const caveResult = buildTerrainLayer(caveOnly.scene, makeWalledRoom(size, 2468), {
      terrainPacks: { cave: 'industrial-cave' },
    });
    expect(caveResult.packGroundDecalCount).toBeGreaterThan(0);
  });
});

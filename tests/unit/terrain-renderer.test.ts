/**
 * terrain-renderer characterization — the w2 single-texture tile-stamp path.
 *
 * `buildTerrainLayer` bakes a FloorMap into one RenderTexture, choosing per tile
 * by precedence: GENERATED single-PNG texture → Kenney sheet frame → solid color.
 * These tests exercise that precedence deterministically against the REAL
 * `buildTerrainLayer` (rule #10 observe-before-done: the unit gate proves per-type
 * stamp correctness; the e2e gate proves the real MainGameScene stamps them).
 *
 * The scene + RenderTexture are minimal mocks (no WebGL): the mock RT records
 * every `stamp`/`fill` so we can assert which texture key + frame + scale each
 * tile resolved to. `textures.exists` / `getSourceImage().width` are configurable
 * so we can drive the missing-texture and invalid-width fallbacks.
 */
import type Phaser from 'phaser';
import { describe, it, expect } from 'vitest';
import { buildTerrainLayer } from '../../src/engine/terrain-renderer.js';
import { getTileVisual } from '../../src/engine/sprites/tile-visuals.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { BiomeType, TerrainType, TilePresets, type MapConfig } from '../../src/shared/map-types.js';
import { PIXELS_PER_FOOT } from '../../src/shared/units.js';

interface StampCall {
  key: string;
  frame: number | undefined;
  x: number;
  y: number;
  config: { originX: number; originY: number; scaleX: number; scaleY: number };
}
interface FillCall {
  color: number;
  alpha: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Records every stamp/fill command so tests can assert per-tile provenance. */
class MockRenderTexture {
  x = 0;
  y = 0;
  originX = 0.5;
  originY = 0.5;
  width = 0;
  height = 0;
  depth = 0;
  readonly stamps: StampCall[] = [];
  readonly fills: FillCall[] = [];
  /** Cleared regions, in call order, so tests can assert draw ORDER vs stamps. */
  readonly clears: FillCall[] = [];

  setOrigin(x: number, y: number): this {
    this.originX = x;
    this.originY = y;
    return this;
  }

  clear(x: number, y: number, w: number, h: number): this {
    this.clears.push({ color: 0, alpha: 0, x, y, w, h });
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

  fill(color: number, alpha: number, x: number, y: number, w: number, h: number): this {
    this.fills.push({ color, alpha, x, y, w, h });
    return this;
  }

  render(): this {
    return this;
  }
}

interface TerrainSceneStub {
  scene: Phaser.Scene;
  rt: MockRenderTexture;
  /** How many times getSourceImage() was called per texture key (memo proof). */
  sourceImageCalls: Map<string, number>;
}

/**
 * A minimal mock scene for `buildTerrainLayer`. `loadedTextures` gates
 * `textures.exists`; `sourceWidths` overrides the pixel width returned by
 * `getSourceImage()` (default 256, matching the approved generated tile PNGs).
 */
function createTerrainScene(opts: {
  loadedTextures: Set<string>;
  sourceWidths?: Map<string, number>;
}): TerrainSceneStub {
  const rt = new MockRenderTexture();
  const sourceImageCalls = new Map<string, number>();
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
      exists: (key: string) => opts.loadedTextures.has(key),
      get: (key: string) => ({
        getSourceImage: () => {
          sourceImageCalls.set(key, (sourceImageCalls.get(key) ?? 0) + 1);
          return { width: opts.sourceWidths?.get(key) ?? 256, height: 256 };
        },
      }),
    },
  } as unknown as Phaser.Scene;
  return { scene, rt, sourceImageCalls };
}

const TILE_SIZE_FT = 16; // → tileSize = 128px; generated scale = 128/256 = 0.5 (distinct from 1)

/** Build a real FloorMap whose terrain is exactly `terrainTypes` (row-major). */
function makeFloorMap(
  terrainTypes: TerrainType[],
  widthTiles: number,
  heightTiles: number,
): FloorMap {
  const config: MapConfig = {
    widthTiles,
    heightTiles,
    tileSizeFt: TILE_SIZE_FT,
    biome: BiomeType.ARENA,
    seed: 42,
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

const tileSize = TILE_SIZE_FT * PIXELS_PER_FOOT; // 128
const GENERATED_SCALE = tileSize / 256; // 0.5

// The four F1 terrain types wired to a generated single-PNG texture in w2.
const GENERATED_TYPES = [
  TerrainType.STONE_FLOOR,
  TerrainType.STONE_WALL,
  TerrainType.BOSS_STAIR_FLOOR,
  TerrainType.SAFE_ROOM_FLOOR,
] as const;

function textureKeyOf(type: TerrainType): string {
  const key = getTileVisual(type)?.textureKey;
  if (!key) throw new Error(`expected textureKey on ${TerrainType[type]}`);
  return key;
}

describe('buildTerrainLayer — generated tile wiring (w2)', () => {
  it('wires a generated textureKey on all four F1 terrain types', () => {
    // The wiring itself: tile-visuals.ts must carry a textureKey per F1 type.
    for (const type of GENERATED_TYPES) {
      expect(getTileVisual(type)?.textureKey).toMatch(/^tile-.+-var-\d+$/);
    }
  });

  it('stamps the generated whole-texture (scaled) for each F1 type, bypassing Kenney frames', () => {
    const generatedKeys = GENERATED_TYPES.map(textureKeyOf);
    const sheetKeys = GENERATED_TYPES.map((t) => getTileVisual(t)!.sheetKey);
    const { scene, rt } = createTerrainScene({
      loadedTextures: new Set([...generatedKeys, ...sheetKeys]),
    });

    const result = buildTerrainLayer(scene, makeFloorMap([...GENERATED_TYPES], 4, 1));

    expect(result.generatedCount).toBe(4);
    expect(result.spriteCount).toBe(0);
    expect(result.colorCount).toBe(0);

    // Every stamp is a generated key with the default (__BASE) frame — no Kenney
    // frame index leaks through — and is scaled tileSize/sourceWidth.
    expect(rt.stamps).toHaveLength(4);
    for (const stamp of rt.stamps) {
      expect(generatedKeys).toContain(stamp.key);
      expect(stamp.frame).toBeUndefined();
      expect(stamp.config.scaleX).toBe(GENERATED_SCALE);
      expect(stamp.config.scaleY).toBe(GENERATED_SCALE);
      expect(stamp.config.originX).toBe(0);
      expect(stamp.config.originY).toBe(0);
    }
    // All four distinct generated keys were stamped.
    expect(new Set(rt.stamps.map((s) => s.key))).toEqual(new Set(generatedKeys));
  });

  it('bakes STONE_WALL as its generated texture (not the autotile frames)', () => {
    // STONE_WALL carries both `frames` (autotile) and `textureKey`; the generated
    // branch must win — a single PNG has no per-mask sub-frames.
    const wallKey = textureKeyOf(TerrainType.STONE_WALL);
    const { scene, rt } = createTerrainScene({
      loadedTextures: new Set([wallKey, getTileVisual(TerrainType.STONE_WALL)!.sheetKey]),
    });

    buildTerrainLayer(scene, makeFloorMap([TerrainType.STONE_WALL], 1, 1));

    expect(rt.stamps).toHaveLength(1);
    expect(rt.stamps[0]!.key).toBe(wallKey);
    expect(rt.stamps[0]!.frame).toBeUndefined();
  });

  it('stamps the generated corridor texture (F1 terrain follow-up, 5/6 wired)', () => {
    // CORRIDOR was Kenney-only through w2; this follow-up wires its generated
    // single-PNG (var-10) via the same textureKey seam, so the generated branch
    // must win over the RPG cobblestone frame when the texture is loaded.
    const corridor = getTileVisual(TerrainType.CORRIDOR)!;
    expect(corridor.textureKey).toBe('tile-corridor-var-10');
    const { scene, rt } = createTerrainScene({
      loadedTextures: new Set([corridor.textureKey!, corridor.sheetKey]),
    });

    const result = buildTerrainLayer(scene, makeFloorMap([TerrainType.CORRIDOR], 1, 1));

    expect(result.generatedCount).toBe(1);
    expect(result.spriteCount).toBe(0);
    expect(rt.stamps).toHaveLength(1);
    expect(rt.stamps[0]!.key).toBe(corridor.textureKey);
    expect(rt.stamps[0]!.frame).toBeUndefined();
    expect(rt.stamps[0]!.config.scaleX).toBe(GENERATED_SCALE);
  });

  it('falls back to the Kenney corridor frame when the generated texture is not loaded', () => {
    const corridor = getTileVisual(TerrainType.CORRIDOR)!;
    // textureKey present but not loaded → RPG cobblestone frame (safe fallback).
    const { scene, rt } = createTerrainScene({
      loadedTextures: new Set([corridor.sheetKey]),
    });

    const result = buildTerrainLayer(scene, makeFloorMap([TerrainType.CORRIDOR], 1, 1));

    expect(result.generatedCount).toBe(0);
    expect(result.spriteCount).toBe(1);
    expect(rt.stamps[0]!.key).toBe(corridor.sheetKey);
    expect(typeof rt.stamps[0]!.frame).toBe('number');
  });

  it('renders a Kenney sheet frame for a type without a generated textureKey', () => {
    const cave = getTileVisual(TerrainType.CAVE_FLOOR)!;
    expect(cave.textureKey).toBeUndefined();
    const { scene, rt } = createTerrainScene({
      loadedTextures: new Set([cave.sheetKey]),
    });

    const result = buildTerrainLayer(scene, makeFloorMap([TerrainType.CAVE_FLOOR], 1, 1));

    expect(result.generatedCount).toBe(0);
    expect(result.spriteCount).toBe(1);
    expect(rt.stamps).toHaveLength(1);
    expect(rt.stamps[0]!.key).toBe(cave.sheetKey);
    expect(typeof rt.stamps[0]!.frame).toBe('number');
  });

  it('falls back to the Kenney frame when the generated texture is not loaded', () => {
    const floorVisual = getTileVisual(TerrainType.STONE_FLOOR)!;
    // Kenney sheet is loaded but the generated key is NOT → Kenney fallback.
    const { scene, rt } = createTerrainScene({
      loadedTextures: new Set([floorVisual.sheetKey]),
    });

    const result = buildTerrainLayer(scene, makeFloorMap([TerrainType.STONE_FLOOR], 1, 1));

    expect(result.generatedCount).toBe(0);
    expect(result.spriteCount).toBe(1);
    expect(rt.stamps).toHaveLength(1);
    expect(rt.stamps[0]!.key).toBe(floorVisual.sheetKey);
    expect(rt.stamps[0]!.key).not.toBe(floorVisual.textureKey);
    expect(typeof rt.stamps[0]!.frame).toBe('number');
  });

  it('falls back to the Kenney frame when the generated texture has an invalid width', () => {
    const floorVisual = getTileVisual(TerrainType.STONE_FLOOR)!;
    const genKey = textureKeyOf(TerrainType.STONE_FLOOR);
    // Generated texture EXISTS but reports width 0 → unusable → Kenney fallback.
    const { scene, rt } = createTerrainScene({
      loadedTextures: new Set([genKey, floorVisual.sheetKey]),
      sourceWidths: new Map([[genKey, 0]]),
    });

    const result = buildTerrainLayer(scene, makeFloorMap([TerrainType.STONE_FLOOR], 1, 1));

    expect(result.generatedCount).toBe(0);
    expect(result.spriteCount).toBe(1);
    expect(rt.stamps[0]!.key).toBe(floorVisual.sheetKey);
  });

  it('falls back to the solid-color fill when neither generated nor sheet texture is loaded', () => {
    // VOID has no visual entry at all → color path regardless of loaded textures.
    const { scene, rt } = createTerrainScene({ loadedTextures: new Set() });

    const result = buildTerrainLayer(scene, makeFloorMap([TerrainType.VOID], 1, 1));

    expect(result.generatedCount).toBe(0);
    expect(result.spriteCount).toBe(0);
    expect(result.colorCount).toBe(1);
    expect(rt.stamps).toHaveLength(0);
    expect(rt.fills).toHaveLength(1);
  });

  it('resolves the generated scale once per texture key (memoized across tiles)', () => {
    const genKey = textureKeyOf(TerrainType.STONE_FLOOR);
    const { scene, sourceImageCalls } = createTerrainScene({
      loadedTextures: new Set([genKey, getTileVisual(TerrainType.STONE_FLOOR)!.sheetKey]),
    });

    // Four STONE_FLOOR tiles share one texture key.
    const result = buildTerrainLayer(
      scene,
      makeFloorMap(Array(4).fill(TerrainType.STONE_FLOOR) as TerrainType[], 4, 1),
    );

    expect(result.generatedCount).toBe(4);
    // getSourceImage() called exactly once despite four tiles — the scale memo works.
    expect(sourceImageCalls.get(genKey)).toBe(1);
  });

  it('reports diagnostic counts that sum to the tile total across a mixed map', () => {
    const generatedKeys = GENERATED_TYPES.map(textureKeyOf);
    const sheetKeys = GENERATED_TYPES.map((t) => getTileVisual(t)!.sheetKey);
    const caveSheet = getTileVisual(TerrainType.CAVE_FLOOR)!.sheetKey;
    const { scene } = createTerrainScene({
      loadedTextures: new Set([...generatedKeys, ...sheetKeys, caveSheet]),
    });

    // 4 generated + 1 Kenney (cave floor) + 1 color (void) = 6 tiles.
    const terrain = [...GENERATED_TYPES, TerrainType.CAVE_FLOOR, TerrainType.VOID];
    const result = buildTerrainLayer(scene, makeFloorMap(terrain, 6, 1));

    expect(result.generatedCount).toBe(4);
    expect(result.spriteCount).toBe(1);
    expect(result.colorCount).toBe(1);
    expect(result.generatedCount + result.spriteCount + result.colorCount).toBe(terrain.length);
  });
});

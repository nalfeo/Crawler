/**
 * Terrain-bake harness — a counting RenderTexture + scene stub plus a real
 * Floor 1 / Floor 2 `FloorMap`, shared by the terrain bake benchmark
 * (`tests/bench/terrain-bake.bench.ts`) and the renderer's command-count
 * regression tests (`tests/unit/terrain-bake-commands.test.ts`).
 *
 * Why this exists
 * ---------------
 * `buildTerrainLayer` is the single most expensive step of floor load. Its cost
 * is dominated by how many commands it queues into Phaser's DynamicTexture
 * command buffer, and NOT every command costs the same: in
 * `DynamicTextureHandler.run` a `STAMP` batches with its neighbours, while a
 * `CLEAR` clones the drawing context, sets a scissor box, issues a `glClear`
 * and releases the clone — which breaks the in-flight quad batch every time.
 *
 * Command counts are therefore the deterministic, CI-safe proxy for bake cost.
 * Wall-clock ms is recorded by the benchmark as advisory only.
 *
 * The mock RT records counts (and, when `record` is set, full call detail) so a
 * test can assert both "this bake got cheaper" and "this bake draws the same
 * pixels". It is deliberately allocation-light in counting mode: recording
 * 33,600 tiles' worth of call objects would dominate the benchmark it measures.
 */

import type Phaser from 'phaser';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { getGenerator } from '../../src/core/map/generators/registry.js';
import { getTerrainPack } from '../../src/shared/terrain-pack-registry.js';
import { BiomeType, type MapConfig } from '../../src/shared/map-types.js';
import type { TerrainPackDef, TerrainPackId } from '../../src/shared/terrain-pack-types.js';
import { SeededRandom } from '../../src/shared/random.js';

/** One recorded `stamp` call. Only populated when `record` is enabled. */
export interface RecordedStamp {
  readonly key: string;
  readonly frame: number | undefined;
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly rotation: number | undefined;
  readonly flipX: boolean | undefined;
}

/** One recorded `fill` or `clear` call. Only populated when `record` is enabled. */
export interface RecordedRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly color?: number;
}

/** Per-command-type totals for one bake. */
export interface BakeCommandCounts {
  readonly stamps: number;
  readonly fills: number;
  readonly clears: number;
  /** `stamps + fills + clears` — the total command-buffer entry count. */
  readonly total: number;
}

/**
 * A RenderTexture stub that counts (and optionally records) every draw command.
 *
 * Mirrors only the surface `buildTerrainLayer` touches. `render()` is a no-op:
 * there is no GL context here, and the command counts are the measurement.
 */
interface CountingRenderTextureLike {
  x: number;
  y: number;
  originX: number;
  originY: number;
  width: number;
  height: number;
  depth: number;
  stampCount: number;
  fillCount: number;
  clearCount: number;
  readonly stamps: RecordedStamp[];
  readonly fills: RecordedRect[];
  readonly clears: RecordedRect[];
  setOrigin(x: number, y: number): this;
  setDepth(depth: number): this;
  clear(x: number, y: number, w: number, h: number): this;
  stamp(
    key: string,
    frame: number | undefined,
    x: number,
    y: number,
    config?: {
      scaleX?: number;
      scaleY?: number;
      rotation?: number;
      flipX?: boolean;
    },
  ): this;
  fill(color: number, alpha: number, x: number, y: number, w: number, h: number): this;
  render(): this;
  destroy(): void;
  counts(): BakeCommandCounts;
}

class CountingRenderTexture implements CountingRenderTextureLike {
  x = 0;
  y = 0;
  originX = 0.5;
  originY = 0.5;
  width = 0;
  height = 0;
  depth = 0;

  stampCount = 0;
  fillCount = 0;
  clearCount = 0;

  /** Populated only when constructed with `record: true`. */
  readonly stamps: RecordedStamp[] = [];
  readonly fills: RecordedRect[] = [];
  readonly clears: RecordedRect[] = [];

  constructor(private readonly record = false) {}

  setOrigin(x: number, y: number): this {
    this.originX = x;
    this.originY = y;
    return this;
  }

  setDepth(depth: number): this {
    this.depth = depth;
    return this;
  }

  clear(x: number, y: number, w: number, h: number): this {
    this.clearCount++;
    if (this.record) this.clears.push({ x, y, w, h });
    return this;
  }

  stamp(
    key: string,
    frame: number | undefined,
    x: number,
    y: number,
    config?: {
      scaleX?: number;
      scaleY?: number;
      rotation?: number;
      flipX?: boolean;
    },
  ): this {
    this.stampCount++;
    if (this.record) {
      this.stamps.push({
        key,
        frame,
        x,
        y,
        scaleX: config?.scaleX ?? 1,
        scaleY: config?.scaleY ?? 1,
        rotation: config?.rotation,
        flipX: config?.flipX,
      });
    }
    return this;
  }

  fill(color: number, _alpha: number, x: number, y: number, w: number, h: number): this {
    this.fillCount++;
    if (this.record) this.fills.push({ x, y, w, h, color });
    return this;
  }

  render(): this {
    return this;
  }

  destroy(): void {
    /* no-op */
  }

  counts(): BakeCommandCounts {
    return {
      stamps: this.stampCount,
      fills: this.fillCount,
      clears: this.clearCount,
      total: this.stampCount + this.fillCount + this.clearCount,
    };
  }
}

/** Scene stub plus the RT it handed to `buildTerrainLayer`. */
export interface TerrainBakeScene {
  readonly scene: Phaser.Scene;
  readonly rt: CountingRenderTextureLike;
  /** How many times `textures.exists` was queried (hoisting proof). */
  textureExistsCalls: number;
}

/**
 * Every texture key a pack can ask for. Used so the harness scene reports the
 * SAME loaded-texture set a real post-boot scene would, which is what makes the
 * benchmark exercise the real pack path rather than the color fallback.
 */
export function packTextureKeys(pack: TerrainPackDef): string[] {
  const keys: string[] = [pack.wallAutotile.textureKey];
  for (const variant of pack.floorPool) keys.push(variant.textureKey);
  for (const variant of pack.corridorPool) keys.push(variant.textureKey);
  for (const pool of Object.values(pack.specialFloorPools ?? {})) {
    for (const variant of pool ?? []) keys.push(variant.textureKey);
  }
  for (const accent of pack.wallAccents ?? []) keys.push(accent.textureKey);
  for (const decals of pack.groundDecals ?? []) keys.push(decals.textureKey);
  for (const layer of pack.linework ?? []) {
    keys.push(layer.textureKey);
    if (layer.props) keys.push(layer.props.textureKey);
  }
  return keys;
}

/**
 * Build a scene stub whose `textures.exists` returns true for `loadedTextures`.
 *
 * `getSourceImage()` reports a 256px-wide source, matching the approved
 * generated tile PNGs, so the generated-tile branch resolves a real scale.
 */
export function createBakeScene(options: {
  loadedTextures: Iterable<string>;
  record?: boolean;
  /**
   * Reported source-image size for the generated-tile path. Defaults to the
   * square 256x256 of the approved generated PNGs. A test can report a TALLER
   * source to exercise the width-derived-scale overflow path, since
   * `resolveGeneratedScale` scales by width alone.
   */
  sourceImageSize?: { width: number; height: number };
}): TerrainBakeScene {
  const loaded = new Set(options.loadedTextures);
  const rt = new CountingRenderTexture(options.record ?? false);
  const state: TerrainBakeScene = {
    scene: undefined as unknown as Phaser.Scene,
    rt,
    textureExistsCalls: 0,
  };
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
      exists: (key: string) => {
        state.textureExistsCalls++;
        return loaded.has(key);
      },
      get: () => ({
        getSourceImage: () => options.sourceImageSize ?? { width: 256, height: 256 },
      }),
    },
  } as unknown as Phaser.Scene;
  return Object.assign(state, { scene });
}

/** Scene stub with every texture of the given packs loaded. */
export function createPackBakeScene(
  packIds: readonly TerrainPackId[],
  record = false,
): TerrainBakeScene {
  const keys = packIds.flatMap((id) => packTextureKeys(getTerrainPack(id)));
  return createBakeScene({ loadedTextures: keys, record });
}

/**
 * The real Floor 1 map dimensions, mirrored from
 * `src/shared/data/floors/floor1.manifest.json`. Duplicated as literals rather
 * than imported so a manifest retune cannot silently move the benchmark's
 * baseline out from under the recorded numbers.
 */
export const FLOOR1_BAKE_CONFIG: MapConfig = {
  widthTiles: 240,
  heightTiles: 140,
  tileSizeFt: 4,
  biome: BiomeType.BASIC_UNDERGROUND,
  seed: 42,
  roomWidthRange: [10, 22],
  roomHeightRange: [9, 20],
  maxRooms: 70,
  floorDensity: 0.36,
};

/** Same, for Floor 2 — the pack with accents, ground decals and linework. */
export const FLOOR2_BAKE_CONFIG: MapConfig = {
  widthTiles: 200,
  heightTiles: 200,
  tileSizeFt: 4,
  biome: BiomeType.CAVE_SYSTEM,
  seed: 84,
  roomWidthRange: [12, 24],
  roomHeightRange: [10, 20],
  maxRooms: 55,
  floorDensity: 0.35,
};

/**
 * Generate a real FloorMap through the real generator, deterministically.
 *
 * The seed is fixed so the benchmark measures the same 33,600 tiles on every
 * run and a command-count assertion is stable across machines.
 */
export function generateBakeFloorMap(config: MapConfig): FloorMap {
  return getGenerator(config.biome).generate(config, new SeededRandom(config.seed));
}

/**
 * Shared test harness for {@link createPhaserBridge} characterization.
 *
 * The PhaserBridge maps ECS entities to Phaser game objects. To exercise that
 * mapping deterministically — without a real WebGL canvas — these helpers
 * provide a minimal mock `Phaser.Scene` whose `add.image(...)` records a
 * lightweight {@link MockImage} for every sprite the bridge creates.
 *
 * The stub deliberately exposes ONLY `add.image` (plus an optional `textures`
 * probe). The bridge guards optional shape factories (e.g. `add.ellipse` for
 * gem/gold shadows) behind a `typeof scene.add.ellipse === 'function'` check, so
 * a stub without them yields exactly one image per renderable entity — the
 * cleanest surface for counting/identity assertions.
 *
 * Extracted from `tests/unit/phaser-bridge.test.ts` so the original behavioral
 * suite and the additive characterization suite share one harness (no
 * duplication; reusable fixtures live in `tests/fixtures/` per
 * `.github/instructions/tests.instructions.md`).
 */
import type Phaser from 'phaser';
import { vi } from 'vitest';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { BiomeType, TilePresets, type MapConfig } from '../../src/shared/map-types.js';

/**
 * Records the mutable visual state the bridge drives on a Phaser image, so tests
 * can assert position, texture, tint, scale, visibility, crop and destruction
 * without a renderer. Mirrors the slice of `Phaser.GameObjects.Image` the bridge
 * actually touches.
 */
export class MockImage {
  destroyed = false;
  visible = true;
  alpha = 1;
  scaleX = 1;
  scaleY = 1;
  rotation = 0;
  tint = 0xffffff;
  tinted = false;
  frame: number | undefined;

  constructor(
    public x: number,
    public y: number,
    public textureKey: string,
    frame?: number,
  ) {
    this.frame = frame;
  }

  setPosition(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }

  setTexture(key: string, frame?: number): this {
    this.textureKey = key;
    // Match Phaser semantics: setTexture(key) resets frame to the texture default.
    this.frame = frame ?? 0;
    return this;
  }

  setAlpha(alpha: number): this {
    this.alpha = alpha;
    return this;
  }

  setTint(tint: number): this {
    this.tint = tint;
    this.tinted = true;
    return this;
  }

  clearTint(): this {
    this.tint = 0xffffff;
    this.tinted = false;
    return this;
  }

  setScale(x: number, y?: number): this {
    this.scaleX = x;
    this.scaleY = y ?? x;
    return this;
  }

  setRotation(rotation: number): this {
    this.rotation = rotation;
    return this;
  }

  setVisible(visible: boolean): this {
    this.visible = visible;
    return this;
  }

  // --- Additions exercised by the corpse-shatter VFX ---
  originX = 0.5;
  originY = 0.5;
  depth = 0;
  cropped = false;
  cropRect: { x: number; y: number; w: number; h: number } | null = null;

  setOrigin(x: number, y: number): this {
    this.originX = x;
    this.originY = y;
    return this;
  }

  setDepth(depth: number): this {
    this.depth = depth;
    return this;
  }

  setCrop(x: number, y: number, w: number, h: number): this {
    this.cropped = true;
    this.cropRect = { x, y, w, h };
    return this;
  }

  get isTinted(): boolean {
    return this.tinted;
  }

  get tintTopLeft(): number {
    return this.tint;
  }

  get texture(): { key: string } {
    return { key: this.textureKey };
  }

  destroy(): void {
    this.destroyed = true;
  }
}

/** Result of {@link createSceneStub}: the recorded images plus the mock scene. */
export interface SceneStub {
  images: MockImage[];
  scene: Phaser.Scene;
}

/**
 * Build a minimal mock scene. `add.image(...)` pushes a {@link MockImage} into
 * `images` and returns it. `kenneyLoaded` toggles the optional `textures.exists`
 * probe so tests can exercise both the procedural and Kenney sprite-sheet paths.
 */
export function createSceneStub(options: { kenneyLoaded?: boolean } = {}): SceneStub {
  const images: MockImage[] = [];
  const image = vi.fn((x = 0, y = 0, textureKey = '', frame?: number) => {
    const mockImage = new MockImage(x, y, textureKey, frame);
    images.push(mockImage);
    return mockImage as unknown as Phaser.GameObjects.Image;
  });

  const textures = options.kenneyLoaded ? { exists: (_key: string) => true } : undefined;

  return {
    images,
    scene: {
      add: {
        image,
      },
      textures,
    } as unknown as Phaser.Scene,
  };
}

/** A small revealed single-room floor used by FOV-visibility characterization. */
export function createBridgeTestMap(): FloorMap {
  const config: MapConfig = {
    widthTiles: 20,
    heightTiles: 20,
    tileSizeFt: 32,
    biome: BiomeType.ARENA,
    seed: 42,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 0.5,
  };
  const tileMap = new TileMap(20, 20);
  tileMap.fill(TilePresets.FLOOR);
  return new FloorMap(config, tileMap, new RoomGraph(), new Uint8Array(400), { x: 10, y: 10 });
}

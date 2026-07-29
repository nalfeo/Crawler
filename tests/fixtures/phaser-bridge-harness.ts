/**
 * Shared test harness for {@link createPhaserBridge} characterization.
 *
 * The PhaserBridge maps ECS entities to Phaser game objects. To exercise that
 * mapping deterministically — without a real WebGL canvas — these helpers
 * provide a minimal mock `Phaser.Scene` whose `add.image(...)` records a
 * lightweight {@link MockImage} for every sprite the bridge creates.
 *
 * The stub exposes `add.image` plus optional `add.graphics` (for features like
 * enemy health bars). By default graphics are omitted, so a stub world with only
 * sprite-like entities yields exactly one image per renderable entity — the
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

/** Fill tint mode value re-exported from PhaserBridge; used by tests to distinguish fill from multiply mode. */
export { PHASER_TINT_MODE_FILL } from '../../src/engine/PhaserBridge.js';

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
  flipX = false;
  flipY = false;
  scaleX = 1;
  scaleY = 1;
  rotation = 0;
  tint = 0xffffff;
  tinted = false;
  tintMode = 0;
  frame: number | undefined;
  displayWidth: number | undefined;
  displayHeight: number | undefined;

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

  setTintMode(mode: number): this {
    this.tintMode = mode;
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

  setDisplaySize(width: number, height: number): this {
    this.displayWidth = width;
    this.displayHeight = height;
    return this;
  }

  setRotation(rotation: number): this {
    this.rotation = rotation;
    return this;
  }

  setAngle(angleDeg: number): this {
    this.rotation = (angleDeg * Math.PI) / 180;
    return this;
  }

  setVisible(visible: boolean): this {
    this.visible = visible;
    return this;
  }

  setFlipX(flipX: boolean): this {
    this.flipX = flipX;
    return this;
  }

  setFlipY(flipY: boolean): this {
    this.flipY = flipY;
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

export class MockGraphics {
  destroyed = false;
  visible = true;
  alpha = 1;
  depth = 0;
  x = 0;
  y = 0;
  rotation = 0;
  scaleX = 1;
  scaleY = 1;
  name = '';
  fillRects: Array<{ x: number; y: number; w: number; h: number }> = [];
  fillEllipses: Array<{ x: number; y: number; w: number; h: number }> = [];
  fillCalls: Array<{ color: number; alpha: number }> = [];
  moveToCalls: Array<{ x: number; y: number }> = [];
  lineToCalls: Array<{ x: number; y: number }> = [];
  fillCircleCalls: Array<{ x: number; y: number; r: number }> = [];
  lineStyleCalls: Array<{ width: number; color: number; alpha: number }> = [];

  clear(): this {
    this.fillRects = [];
    this.fillEllipses = [];
    this.fillCalls = [];
    this.moveToCalls = [];
    this.lineToCalls = [];
    this.fillCircleCalls = [];
    this.lineStyleCalls = [];
    return this;
  }

  fillStyle(color: number, alpha = 1): this {
    this.fillCalls.push({ color, alpha });
    return this;
  }

  fillRect(x: number, y: number, w: number, h: number): this {
    this.fillRects.push({ x, y, w, h });
    return this;
  }

  fillEllipse(x: number, y: number, w: number, h: number): this {
    this.fillEllipses.push({ x, y, w, h });
    return this;
  }

  lineStyle(width: number, color: number, alpha = 1): this {
    this.lineStyleCalls.push({ width, color, alpha });
    return this;
  }

  strokeRect(_x: number, _y: number, _w: number, _h: number): this {
    return this;
  }

  beginPath(): this {
    return this;
  }

  moveTo(x: number, y: number): this {
    this.moveToCalls.push({ x, y });
    return this;
  }

  lineTo(x: number, y: number): this {
    this.lineToCalls.push({ x, y });
    return this;
  }

  strokePath(): this {
    return this;
  }

  arc(
    _x: number,
    _y: number,
    _r: number,
    _a0: number,
    _a1: number,
    _anticlockwise?: boolean,
  ): this {
    return this;
  }

  fillCircle(x: number, y: number, r: number): this {
    this.fillCircleCalls.push({ x, y, r });
    return this;
  }

  strokeCircle(_x: number, _y: number, _r: number): this {
    return this;
  }

  setVisible(visible: boolean): this {
    this.visible = visible;
    return this;
  }

  setAlpha(alpha: number): this {
    this.alpha = alpha;
    return this;
  }

  setDepth(depth: number): this {
    this.depth = depth;
    return this;
  }

  setRotation(rotation: number): this {
    this.rotation = rotation;
    return this;
  }

  setScale(scaleX: number, scaleY?: number): this {
    this.scaleX = scaleX;
    this.scaleY = scaleY ?? scaleX;
    return this;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

class MockText {
  destroyed = false;
  alpha = 1;
  depth = 0;
  originX = 0;
  originY = 0;

  constructor(
    public x: number,
    public y: number,
    public text: string,
  ) {}

  setOrigin(x: number, y: number): this {
    this.originX = x;
    this.originY = y;
    return this;
  }

  setDepth(depth: number): this {
    this.depth = depth;
    return this;
  }

  setY(y: number): this {
    this.y = y;
    return this;
  }

  setAlpha(alpha: number): this {
    this.alpha = alpha;
    return this;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

/** Result of {@link createSceneStub}: the recorded images plus the mock scene. */
export interface SceneStub {
  graphics: MockGraphics[];
  images: MockImage[];
  texts: MockText[];
  scene: Phaser.Scene;
}

/**
 * Build a minimal mock scene. `add.image(...)` pushes a {@link MockImage} into
 * `images` and returns it. `kenneyLoaded` toggles the optional `textures.exists`
 * probe so tests can exercise both the procedural and Kenney sprite-sheet paths.
 */
export function createSceneStub(
  options: {
    kenneyLoaded?: boolean;
    withGraphics?: boolean;
    /**
     * Narrows which texture keys `textures.exists` reports. Needed to separate
     * the generated-art path from the Kenney-sheet fallback now that render
     * kinds (e.g. `player`) can have BOTH — without it every key exists and the
     * generated branch always wins, hiding the fallback path from tests.
     */
    textureExists?: (key: string) => boolean;
  } = {},
): SceneStub {
  const images: MockImage[] = [];
  const graphics: MockGraphics[] = [];
  const texts: MockText[] = [];
  const image = vi.fn((x = 0, y = 0, textureKey = '', frame?: number) => {
    const mockImage = new MockImage(x, y, textureKey, frame);
    images.push(mockImage);
    return mockImage as unknown as Phaser.GameObjects.Image;
  });
  const addGraphics = vi.fn((config?: { x?: number; y?: number }) => {
    const mockGraphics = new MockGraphics();
    if (config && typeof config === 'object') {
      mockGraphics.x = config.x ?? 0;
      mockGraphics.y = config.y ?? 0;
    }
    graphics.push(mockGraphics);
    return mockGraphics as unknown as Phaser.GameObjects.Graphics;
  });
  const addText = vi.fn((x = 0, y = 0, text = '') => {
    const mockText = new MockText(x, y, text);
    texts.push(mockText);
    return mockText as unknown as Phaser.GameObjects.Text;
  });

  const textures = options.kenneyLoaded
    ? { exists: (key: string) => options.textureExists?.(key) ?? true }
    : undefined;

  return {
    graphics,
    images,
    texts,
    scene: {
      add: {
        ...(options.withGraphics ? { graphics: addGraphics } : {}),
        image,
        text: addText,
      },
      cameras: {
        getCamera: () => null,
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

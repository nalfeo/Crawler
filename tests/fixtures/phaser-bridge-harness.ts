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
import type { GeneratedSpriteRegistry } from '../../src/shared/generated-assets.js';
import { GENERATED_SPRITE_REGISTRY_KEY } from '../../src/engine/generatedAssets/index.js';

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

  /**
   * Native pixel size of the current texture, as a real
   * `Phaser.GameObjects.Image` reports it. Defaults to `0` (unmeasurable) so
   * every pre-existing test keeps the legacy pixel-multiplier render path;
   * pass `textureSizes` to {@link createSceneStub} to exercise the
   * feet-authored footprint path.
   */
  width = 0;
  height = 0;

  constructor(
    public x: number,
    public y: number,
    public textureKey: string,
    frame?: number,
    private readonly sizeOf: (key: string) => { width: number; height: number } | undefined = () =>
      undefined,
  ) {
    this.frame = frame;
    this.applyTextureSize();
  }

  /**
   * Adopt the native size of the current texture, mirroring Phaser (where
   * `setTexture` re-reads the frame size). Deliberately a NO-OP for keys the
   * resolver does not know, so a test that hand-assigns `width`/`height` on a
   * stub image is not clobbered on the next `setTexture`.
   */
  private applyTextureSize(): void {
    const size = this.sizeOf(this.textureKey);
    if (size === undefined) {
      return;
    }
    this.width = size.width;
    this.height = size.height;
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
    this.applyTextureSize();
    return this;
  }

  setFrame(frame: number): this {
    this.frame = frame;
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

/**
 * Minimal but behaviorally-faithful stand-in for `Phaser.Animations.AnimationManager`.
 * Real Phaser stores a registered animation's frame list + frameRate + repeat
 * config and every `Sprite.anims` (an `AnimationState`) advances its own
 * `currentFrame` against that config once per real game-loop tick. Since these
 * unit tests run with no WebGL/game-loop, {@link MockAnimationState.tick}
 * plays that per-tick advance role explicitly so a test can deterministically
 * assert "the frame index advances while playing, holds while stopped".
 */
class MockAnimationManager {
  private readonly configs = new Map<
    string,
    { frameCount: number; frameRate: number; repeat: number }
  >();

  exists(key: string): boolean {
    return this.configs.has(key);
  }

  create(config: { key: string; frames: unknown; frameRate: number; repeat: number }): void {
    const frames = config.frames;
    const frameCount = Array.isArray(frames) ? frames.length : 1;
    this.configs.set(config.key, {
      frameCount,
      frameRate: config.frameRate,
      repeat: config.repeat,
    });
  }

  generateFrameNumbers(_textureKey: string, config: { start: number; end: number }): number[] {
    const count = config.end - config.start + 1;
    return Array.from({ length: count }, (_, i) => config.start + i);
  }

  getConfig(key: string): { frameCount: number; frameRate: number; repeat: number } | undefined {
    return this.configs.get(key);
  }
}

/**
 * Per-sprite `Sprite.anims` (`AnimationState`) stand-in. `tick(deltaMs)` is a
 * test-only hook that advances `currentFrame` the way Phaser's real
 * `AnimationState.update` would during a game-loop frame, driven by the
 * shared {@link MockAnimationManager}'s registered frameRate for the playing
 * animation. Not part of the production `AnimationManagerLike`/`Sprite.anims`
 * surface the bridge calls — only `play`/`stop`/`currentFrame` are.
 */
class MockAnimationState {
  private currentKey: string | null = null;
  private frameIndex = 0;
  private playing = false;
  private msAccumulator = 0;

  constructor(private readonly manager: MockAnimationManager) {}

  play(key: string, ignoreIfPlaying = false): this {
    if (ignoreIfPlaying && this.playing && this.currentKey === key) {
      return this;
    }
    this.currentKey = key;
    this.frameIndex = 0;
    this.msAccumulator = 0;
    this.playing = true;
    return this;
  }

  stop(): this {
    this.playing = false;
    return this;
  }

  get currentFrame(): { index: number } {
    return { index: this.frameIndex };
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Advance the current animation by `deltaMs` of simulated game-loop time. */
  tick(deltaMs: number): void {
    if (!this.playing || this.currentKey === null) {
      return;
    }
    const config = this.manager.getConfig(this.currentKey);
    if (!config || config.frameCount <= 1) {
      return;
    }
    this.msAccumulator += deltaMs;
    const frameDurationMs = 1000 / config.frameRate;
    while (this.msAccumulator >= frameDurationMs) {
      this.msAccumulator -= frameDurationMs;
      const next = this.frameIndex + 1;
      if (next < config.frameCount) {
        this.frameIndex = next;
      } else if (config.repeat === -1) {
        this.frameIndex = 0;
      } else {
        // Non-looping animation: hold on the last frame.
        this.frameIndex = config.frameCount - 1;
        this.playing = false;
        break;
      }
    }
  }
}

/** `MockImage` plus the `.anims` surface `scene.add.sprite(...)` results carry. */
class MockSprite extends MockImage {
  readonly anims: MockAnimationState;

  constructor(
    x: number,
    y: number,
    textureKey: string,
    frame: number | undefined,
    animationManager: MockAnimationManager,
    sizeOf?: (key: string) => { width: number; height: number } | undefined,
  ) {
    super(x, y, textureKey, frame, sizeOf);
    this.anims = new MockAnimationState(animationManager);
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
  /** Populated only when `options.generatedRegistry` is provided. */
  sprites: MockSprite[];
  /** Populated only when `options.generatedRegistry` is provided. */
  animationManager: MockAnimationManager | null;
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
    /**
     * When provided, wires `scene.game.registry`, `scene.anims` (a
     * {@link MockAnimationManager}), and `scene.add.sprite` so the bridge's
     * generated-sprite-animation path (registration + `Sprite.anims.play/stop`)
     * is fully exercised instead of no-op'd. Purely additive — omitting this
     * keeps every pre-existing test's `scene.anims`/`scene.add.sprite`
     * `undefined`, so the bridge falls back to plain `Image`s exactly as
     * before.
     */
    generatedRegistry?: GeneratedSpriteRegistry;
    /**
     * Native pixel size per texture key. Without it every {@link MockImage}
     * reports `width`/`height` of `0` (unmeasurable), so the bridge falls back
     * to the legacy `generated.scale` pixel multiplier. Supply it to exercise
     * the feet-authored footprint path (`generated.heightFt`), which sizes a
     * sprite from its opaque bounds against the loaded texture size.
     */
    textureSizes?: (key: string) => { width: number; height: number } | undefined;
  } = {},
): SceneStub {
  const images: MockImage[] = [];
  const sprites: MockSprite[] = [];
  const graphics: MockGraphics[] = [];
  const texts: MockText[] = [];
  const sizeOf = options.textureSizes ?? ((): undefined => undefined);
  const image = vi.fn((x = 0, y = 0, textureKey = '', frame?: number) => {
    const mockImage = new MockImage(x, y, textureKey, frame, sizeOf);
    images.push(mockImage);
    return mockImage as unknown as Phaser.GameObjects.Image;
  });
  const animationManager = options.generatedRegistry ? new MockAnimationManager() : null;
  const addSprite = animationManager
    ? vi.fn((x = 0, y = 0, textureKey = '', frame?: number) => {
        const mockSprite = new MockSprite(x, y, textureKey, frame, animationManager, sizeOf);
        sprites.push(mockSprite);
        return mockSprite as unknown as Phaser.GameObjects.Sprite;
      })
    : undefined;
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

  const textures =
    options.kenneyLoaded || options.generatedRegistry
      ? {
          exists: (key: string) => options.textureExists?.(key) ?? true,
          get: (key: string) => ({
            getSourceImage: () => sizeOf(key) ?? { width: 0, height: 0 },
          }),
        }
      : undefined;

  const generatedRegistry = options.generatedRegistry;

  return {
    graphics,
    images,
    texts,
    sprites,
    animationManager,
    scene: {
      add: {
        ...(options.withGraphics ? { graphics: addGraphics } : {}),
        ...(addSprite ? { sprite: addSprite } : {}),
        image,
        text: addText,
      },
      cameras: {
        getCamera: () => null,
      },
      textures,
      ...(animationManager ? { anims: animationManager } : {}),
      ...(generatedRegistry
        ? {
            game: {
              registry: {
                get: (key: string) =>
                  key === GENERATED_SPRITE_REGISTRY_KEY ? generatedRegistry : undefined,
              },
            },
          }
        : {}),
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

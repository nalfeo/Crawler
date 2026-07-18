import { describe, expect, it, vi } from 'vitest';
import { createGoreVfx } from '../../src/engine/GoreVfx.js';
import { createPhaserBridge } from '../../src/engine/PhaserBridge.js';
import { SHATTER_COLS, SHATTER_ROWS } from '../../src/engine/corpse-shatter.js';
import { ftToPx } from '../../src/shared/units.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { createSceneStub } from '../fixtures/phaser-bridge-harness.js';
import type { CombatEvent } from '../../src/shared/combat-events.js';
import { createBloodPoolSurface } from '../../src/shared/blood-surfaces.js';

/**
 * Regression guards for the death-VFX coordinate space. World coordinates are
 * feet (`PIXELS_PER_FOOT = 8`); the render layer must call `ftToPx()`. The #366
 * "feet as the single internal unit" refactor added that conversion to the gore
 * particles but MISSED the blood-pool ellipse and the corpse-shatter hand-off,
 * so both drew at ~1/8 position near the top-left origin and appeared to vanish.
 * These tests assert both VFX land at the pixel death location, not raw feet.
 */

type GoreScene = Parameters<typeof createGoreVfx>[0];

interface GraphicsArgs {
  x: number;
  y: number;
}

interface GraphicsShape {
  x: number;
  y: number;
  fillEllipses: Array<{ x: number; y: number; w: number; h: number }>;
  scaleX: number;
  scaleY: number;
  clear: () => GraphicsShape;
  fillStyle: () => GraphicsShape;
  fillEllipse: (x: number, y: number, w: number, h: number) => GraphicsShape;
  setDepth: () => GraphicsShape;
  setAlpha: () => GraphicsShape;
  setScale: (x: number, y: number) => GraphicsShape;
  destroy: () => void;
}

/** Minimal scene that records `add.graphics` centres (the blood pool). */
function createGoreSceneStub(): {
  scene: GoreScene;
  graphicsCreated: GraphicsArgs[];
  graphicsShapes: GraphicsShape[];
} {
  const graphicsCreated: GraphicsArgs[] = [];
  const graphicsShapes: GraphicsShape[] = [];
  // Particle rectangles; irrelevant for pool positioning, share one shape.
  const rectShape = {
    x: 0,
    y: 0,
    setX: vi.fn(() => rectShape),
    setY: vi.fn(() => rectShape),
    setDepth: vi.fn(() => rectShape),
    setAlpha: vi.fn(() => rectShape),
    setScale: vi.fn(() => rectShape),
    setSize: vi.fn(() => rectShape),
    destroy: vi.fn(),
  };
  const scene = {
    add: {
      rectangle: vi.fn(() => rectShape),
      graphics: vi.fn((config?: { x?: number; y?: number }) => {
        const x = config?.x ?? 0;
        const y = config?.y ?? 0;
        graphicsCreated.push({ x, y });
        const shape: GraphicsShape = {
          x,
          y,
          fillEllipses: [],
          scaleX: 1,
          scaleY: 1,
          clear() {
            shape.fillEllipses = [];
            return shape;
          },
          fillStyle() {
            return shape;
          },
          fillEllipse(cx: number, cy: number, w: number, h: number) {
            shape.fillEllipses.push({ x: cx, y: cy, w, h });
            return shape;
          },
          setDepth() {
            return shape;
          },
          setAlpha() {
            return shape;
          },
          setScale(scaleX: number, scaleY: number) {
            shape.scaleX = scaleX;
            shape.scaleY = scaleY;
            return shape;
          },
          destroy() {
            /* no-op */
          },
        };
        graphicsShapes.push(shape);
        return shape;
      }),
    },
    cameras: { getCamera: vi.fn(() => null) },
  };
  return { scene: scene as unknown as GoreScene, graphicsCreated, graphicsShapes };
}

function corpseExplodeEvent(x: number, y: number): CombatEvent {
  return {
    type: 'corpseExplode',
    x,
    y,
    amount: 12,
    targetType: 'enemy',
    timestamp: 0,
    spriteTextureId: 0,
    bloodColor: 0xcc0000,
    knockbackDirX: 1,
    knockbackDirY: 0,
  };
}

function addAuthoritativePool(
  world: ReturnType<typeof createTestWorld>,
  x: number,
  y: number,
  createdAtMs = 1000,
): void {
  world.bloodPools.push(
    createBloodPoolSurface({
      worldSeed: world.seed,
      poolId: world.bloodyFootprintState.nextPoolId++,
      x,
      y,
      createdAtMs,
    }),
  );
}

describe('death-VFX world→pixel coordinates', () => {
  it('spawns the blood-pool graphics at ftToPx(death position), not raw feet', () => {
    const { scene, graphicsCreated } = createGoreSceneStub();
    const vfx = createGoreVfx(scene, { intensity: 1, hitGoreEnabled: false });
    const world = createTestWorld();

    addAuthoritativePool(world, 100, 50);
    vfx.update(world, 1000, 16, 0);

    expect(graphicsCreated).toHaveLength(1);
    // Only a small (<6px/<4px) organic jitter is added on top of the centre.
    expect(Math.abs(graphicsCreated[0]!.x - ftToPx(100))).toBeLessThan(4);
    expect(Math.abs(graphicsCreated[0]!.y - ftToPx(50))).toBeLessThan(3);
    // Guard against the regression: the centre must NOT be the raw feet value.
    expect(graphicsCreated[0]!.x).toBeGreaterThan(100);
    expect(graphicsCreated[0]!.y).toBeGreaterThan(50);
  });

  it('spawns corpse-shatter shards at ftToPx(corpse position), not raw feet', () => {
    // No `add.rectangle` → the bridge skips GoreVfx and blood specks, leaving the
    // 3x3 shard grid (created via `add.image`) as the only recorded images.
    const { scene, images } = createSceneStub();
    const bridge = createPhaserBridge(scene);
    const world = createTestWorld();

    world.combatEvents.push(corpseExplodeEvent(100, 50));
    bridge.sync(world);

    expect(images).toHaveLength(SHATTER_COLS * SHATTER_ROWS);
    for (const shard of images) {
      // Shards are sprayed symmetrically around the corpse centre, so each one
      // must sit closer to the pixel death location than to the raw-feet value.
      expect(Math.abs(shard.x - ftToPx(100))).toBeLessThan(Math.abs(shard.x - 100));
      expect(Math.abs(shard.y - ftToPx(50))).toBeLessThan(Math.abs(shard.y - 50));
    }
  });
});

describe('blood pool spread shape', () => {
  it('honors intensity zero by not rendering authoritative pools', () => {
    const { scene, graphicsCreated } = createGoreSceneStub();
    const vfx = createGoreVfx(scene, { intensity: 0, hitGoreEnabled: false });
    const world = createTestWorld();

    addAuthoritativePool(world, 100, 50);
    vfx.update(world, 1000, 16, 0);

    expect(graphicsCreated).toHaveLength(0);
  });

  it('draws multiple overlapping sub-lobes so the pool is not a smooth ellipse', () => {
    const { scene, graphicsShapes } = createGoreSceneStub();
    const vfx = createGoreVfx(scene, { intensity: 1, hitGoreEnabled: false });
    const world = createTestWorld();

    addAuthoritativePool(world, 100, 50);
    vfx.update(world, 1000, 16, 0);

    expect(graphicsShapes).toHaveLength(1);
    const pool = graphicsShapes[0]!;
    // The pool must render as several stacked ellipses. A single ellipse
    // would regress the "even/uniform" bug the user reported.
    expect(pool.fillEllipses.length).toBeGreaterThanOrEqual(3);

    // At least one lobe must have a non-zero offset from the pool origin so
    // the outline is visibly asymmetric.
    const offsetLobes = pool.fillEllipses.filter((lobe) => Math.hypot(lobe.x, lobe.y) > 0.1);
    expect(offsetLobes.length).toBeGreaterThan(0);
  });

  it('keeps spreading past 5 seconds — pool is still growing well into its life', () => {
    const { scene, graphicsShapes } = createGoreSceneStub();
    const vfx = createGoreVfx(scene, { intensity: 1, hitGoreEnabled: false });
    const world = createTestWorld();

    addAuthoritativePool(world, 100, 50);
    vfx.update(world, 1000, 16, 0);

    const pool = graphicsShapes[0]!;

    // Sample the total ellipse footprint (sum of w*h across all lobes) at
    // three points in the pool's 30 s life. A pool that expanded to full
    // size in the first ~3.6 s (the old 0.12 expand phase) would have the
    // same footprint at t=5 s and t=15 s, and this assertion would fail.
    const sampleFootprint = (renderElapsedMs: number): number => {
      // Empty the combatEvents so the update loop only animates the pool.
      world.combatEvents.length = 0;
      vfx.update(world, renderElapsedMs, 16, 0);
      return pool.fillEllipses.reduce((total, lobe) => total + lobe.w * lobe.h, 0);
    };

    const footprintAtSpawn = pool.fillEllipses.reduce((total, lobe) => total + lobe.w * lobe.h, 0);
    const footprintAt5s = sampleFootprint(1000 + 5_000);
    const footprintAt15s = sampleFootprint(1000 + 15_000);

    // Pool must be visibly bigger by 5 s (i.e. still spreading), and still
    // strictly bigger by 15 s (spread continues into the second half).
    expect(footprintAt5s).toBeGreaterThan(footprintAtSpawn * 1.5);
    expect(footprintAt15s).toBeGreaterThan(footprintAt5s);
  });

  it('flattens vertically to half height across its lifetime without narrowing', () => {
    const { scene, graphicsShapes } = createGoreSceneStub();
    const vfx = createGoreVfx(scene, { intensity: 1, hitGoreEnabled: false });
    const world = createTestWorld();

    addAuthoritativePool(world, 100, 50);
    vfx.update(world, 1000, 16, 0);

    const pool = graphicsShapes[0]!;
    expect(pool.scaleX).toBe(1);
    expect(pool.scaleY).toBe(1);

    world.combatEvents.length = 0;
    vfx.update(world, 1000 + 15_000, 16, 0);
    expect(pool.scaleX).toBe(1);
    expect(pool.scaleY).toBeCloseTo(0.75);

    vfx.update(world, 1000 + 29_970, 16, 0);
    expect(pool.scaleX).toBe(1);
    expect(pool.scaleY).toBeCloseTo(0.5, 2);
  });
});
